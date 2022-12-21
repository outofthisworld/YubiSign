import express from "express";
import fs from "fs";
import * as Sentry from "@sentry/node";
import AWS from "aws-sdk";
import yubicoPivTool from "yubico-piv-tool";
import crypto from "crypto";
import cron from "cron";
import yubikeyManager from 'yubikey-manager';
import Redlock from 'redlock';

// Amazon s3
const s3 = new AWS.S3();
// Amazon SQS
const sqs = new AWS.SQS();
// Create a Redlock client
const redlock = new Redlock([redis]);

// Initialize the Sentry client
Sentry.init({
  dsn: "https://abc123@sentry.io/1234567" // Set the DSN for your Sentry instance
});

// Function for adding a job to the SQS queue
async function addJob(
  pdfPath: string,
  keySlot: number,
  pin: string,
  bucket: string
): Promise<void> {
  // Create the job data object
  const job = {
    pdfPath,
    keySlot,
    pin,
    bucket
  };

  // Create the message parameters
  const params = {
    MessageBody: JSON.stringify(job), // Set the message body to the job data as a JSON string
    QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue" // Set the URL of the SQS queue
  };

  // Add the message to the queue
  await sqs.sendMessage(params).promise();
}

async function signPdf(
  pdf: Buffer,
  keySlot: number,
  pin: string,
  ykmsUrl: string
): Promise<Buffer> {
  // Connect to the YubiKey Manager Server
  const ykms = yubikeyManager.connect(ykmsUrl);

  // Use the yubikey-manager library to sign the PDF
  const options = {
    signer: keySlot,
    pin,
    input: pdf,
    algorithm: crypto.constants.RSA_PKCS1_PSS_PADDING
  };
  const signedPdf = await ykms.sign(options);
  return signedPdf;
}

async function uploadPdf(
  pdf: Buffer,
  bucket: string,
  key: string
): Promise<void> {
  // Create the upload parameters
  const params = {
    Bucket: bucket, // Set the S3 bucket
    Key: key, // Set the S3 key
    Body: pdf // Set the signed PDF as the file body
  };

  // Upload the signed PDF to S3
  await s3.upload(params).promise();
}

// Function for processing jobs from the SQS queue
async function processJobs(): Promise<void> {
  try {
    // Poll the SQS queue for new jobs
    const params = {
      QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue" // Set the URL of the SQS queue
    };
    const response = await sqs.receiveMessage(params).promise();

    // Process each job in the queue
    if (response.Messages) {
      for (const message of response.Messages) {
        const job = JSON.parse(message.Body);

        // Acquire a lock on the job
        const lockKey = `lock:${job.pdfPath}`;
        const lock = await redlock.lock(lockKey, 1000); // Set the lock to expire after 1000 milliseconds (1 second)

        let retries = 0;
        let succeeded = false;
        while (!succeeded && retries < 5) {
          try {
            // Download the PDF from S3
            const s3Params = {
              Bucket: job.bucket,
              Key: job.pdfPath
            };
            const pdfData = await s3.getObject(s3Params).promise();

            // Sign the PDF using the YubiKey Manager Server
            const signedPdf = await signPdf(
              pdfData.Body,
              job.keySlot,
              job.pin,
              'http://ykms.example.com' // Set the URL of the YubiKey Manager Server
            );

            // Upload the signed PDF to S3
            await uploadPdf(signedPdf, job.bucket, job.pdfPath);

            // Delete the job from the queue
            await sqs.deleteMessage({
              QueueUrl: params.QueueUrl,
              ReceiptHandle: message.ReceiptHandle
            }).promise();

            // Set the succeeded flag to true to exit the loop
            succeeded = true;
          } catch (error) {
            console.error(error);

            // Increment the retry count
            retries++;
          }
        }

        // Release the lock on the job
        await lock.unlock();
      }
    }
  } catch (error) {
    console.error(error);
  }
}

const app = express();

// Endpoint for signing a PDF
app.post("/sign-pdf", async function signPdf(
  req: Request,
  res: Response
): Promise<void> {
  try {
    // Get the PDF data and signing details from the request body
    const pdfPath = req.path;

    const bucket = "Bucket to retrieve/store pdfs";
    const keySlot = 5;
    const pin = "1234";

    Sentry.withScope(async (scope) => {
      scope.setExtra("pdf", pdfPath);
      scope.setExtra("keySlot", keySlot);
      scope.setExtra("pin", pin);
      scope.setExtra("bucket", bucket);

      // Add the job to the SQS queue
      await addJob(pdfPath, keySlot, pin, bucket);
    });

    // Return a success response
    res.status(200).send("PDF signing job added to queue");
  } catch (error) {
    // Capture the error with Sentry
    Sentry.captureException(error);

    // Handle any other errors
    console.error(error);

    res.status(500).send("Error adding PDF signing job to queue");
  }
});

new cron.CronJob({
  // Set the cron pattern for when the job should run
  cronTime: "* * * * *", // Run the job every minute
  onTick: processJobs, // Call the processJobs function when the job runs
  start: true // Start the job immediately
});


// Example of sign PDF using Yubikey piv tool instead of the Yubikey Manager Server
/*async function signPdf(
  pdf: Buffer,
  keySlot: number,
  pin: string
): Promise<Buffer> {
  // Use the yubico-piv-tool library to sign the PDF
  const ypt = new yubicoPivTool();
  const options = {
    signer: keySlot,
    pin,
    input: pdf,
    algorithm: crypto.constants.RSA_PKCS1_PSS_PADDING
  };
  const signedPdf = await ypt.sign(options);
  return signedPdf;
}*/
