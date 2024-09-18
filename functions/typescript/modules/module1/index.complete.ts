import { randomUUID } from 'node:crypto';
import {
  IdempotencyConfig,
  makeIdempotent,
} from '@aws-lambda-powertools/idempotency';
import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';
import { injectLambdaContext } from '@aws-lambda-powertools/logger/middleware';
import { MetricUnit } from '@aws-lambda-powertools/metrics';
import { logMetrics } from '@aws-lambda-powertools/metrics/middleware';
import { captureLambdaHandler } from '@aws-lambda-powertools/tracer/middleware';
import { dynamodbClient } from '@commons/clients/dynamodb';
import { logger, metrics, tracer } from '@commons/powertools';
import {
  FileStatus,
  ImageSize,
  TransformSize,
  transformedImageExtension,
  transformedImagePrefix,
} from '@constants';
import middy from '@middy/core';
import type { Context, EventBridgeEvent } from 'aws-lambda';
import type { Detail, DetailType, ProcessOneOptions } from './types';
import {
  createThumbnail,
  getImageMetadata,
  getOriginalObject,
  markFileAs,
  writeTransformedObjectToS3,
} from './utils';

const s3BucketFiles = process.env.BUCKET_NAME_FILES || '';
const filesTableName = process.env.TABLE_NAME_FILES || '';
const idempotencyTableName = process.env.IDEMPOTENCY_TABLE_NAME || '';

const persistenceStore = new DynamoDBPersistenceLayer({
  tableName: idempotencyTableName,
  awsSdkV3Client: dynamodbClient,
});
const idempotencyConfig = new IdempotencyConfig({
  eventKeyJmesPath: '[etag,userId]',
  throwOnNoIdempotencyKey: true,
  expiresAfterSeconds: 60 * 60 * 2, // 2 hours
});

const processOne = async ({
  objectKey,
}: ProcessOneOptions): Promise<string> => {
  // Open a new subsegment to trace the execution of the function
  const subsegment = tracer.getSegment()?.addNewSubsegment('### processOne');
  const newObjectKey = `${transformedImagePrefix}/${randomUUID()}${transformedImageExtension}`;
  // Get the original image from S3
  const originalImage = await getOriginalObject(objectKey, s3BucketFiles);
  const transform = TransformSize[ImageSize.SMALL];
  // Create thumbnail from original image
  const processedImage = await createThumbnail({
    imageBuffer: originalImage,
    width: transform.width,
    height: transform.height,
  });
  // Save the thumbnail on S3
  await writeTransformedObjectToS3({
    key: newObjectKey,
    bucketName: s3BucketFiles,
    body: processedImage,
  });
  // Add structured logging to the function
  logger.info('Saved image on S3', {
    details: newObjectKey,
  });

  // Annotate the subsegment with the new object key and then close it
  subsegment?.addAnnotation('newObjectKey', newObjectKey);
  subsegment?.close();

  metrics.addMetric('ThumbnailGenerated', MetricUnit.Count, 1);

  return newObjectKey;
};

const processOneIdempotently = makeIdempotent(processOne, {
  persistenceStore,
  config: idempotencyConfig,
});

const lambdaHandler = async (
  event: EventBridgeEvent<DetailType, Detail>,
  context: Context
): Promise<void> => {
  // Register Lambda context to handle potential timeouts
  idempotencyConfig.registerLambdaContext(context);

  // Extract file info from the event and fetch additional metadata from DynamoDB
  const objectKey = event.detail.object.key;
  const etag = event.detail.object.etag;
  const { fileId, userId } = await getImageMetadata(filesTableName, objectKey);

  // Mark file as working, this will notify subscribers that the file is being processed
  await markFileAs(fileId, FileStatus.WORKING);

  try {
    const newObjectKey = await processOneIdempotently({
      fileId,
      objectKey,
      userId,
      etag,
    });

    metrics.addMetric('ImageProcessed', MetricUnit.Count, 1);

    await markFileAs(fileId, FileStatus.DONE, newObjectKey);
  } catch (error) {
    logger.error('An unexpected error occurred', error as Error);

    await markFileAs(fileId, FileStatus.FAIL);

    throw error;
  }
};

export const handler = middy(lambdaHandler)
  .use(captureLambdaHandler(tracer))
  .use(injectLambdaContext(logger, { logEvent: true }))
  .use(logMetrics(metrics));
