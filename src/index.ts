import express from "express";
import fs from "fs";
import * as Sentry from "@sentry/node";
import AWS from "aws-sdk";
import yubicoPivTool from "yubico-piv-tool";
import crypto from "crypto";
import cron from "cron";
const s3 = new AWS.S3();
const sqs = new AWS.SQS();

// Initialize the Sentry client
Sentry.init({
  dsn: "https://abc123@sentry.io/1234567" // Set the DSN for your Sentry instance
});

const app = express();

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

// Function for signing a PDF using a YubiKey
async function signPdf(
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

    // Check if there are any new jobs in the queue
    if (response.Messages) {
      // Process each job in the queue
      for (const message of response.Messages) {
        // Parse the job data from the message body
        const job = JSON.parse(message.Body);
        const { pdfPath, keySlot, pin, bucket } = job;

        // Download the PDF from S3
        const s3Params = {
          Bucket: bucket, // Set the name of the S3 bucket
          Key: pdfPath
        };
        const s3Response = await s3.getObject(s3Params).promise();
        const pdf = s3Response.Body;

        // Sign the PDF using the provided key slot and PIN
        const signedPdf = await signPdf(pdf, keySlot, pin);

        await uploadPdf(signedPdf, bucket, `${pdfPath}.signed`);

        // Delete the original PDF and the signed PDF from the local file system
        fs.unlink(pdfPath, (error) => {
          if (error) {
            console.error(error);
          }
        });
        fs.unlink(`${pdfPath}.signed`, (error) => {
          if (error) {
            console.error(error);
          }
        });

        // Delete the message from the SQS queue
        const deleteParams = {
          QueueUrl: "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue", // Set the URL of the SQS queue
          ReceiptHandle: message.ReceiptHandle
        };
        await sqs.deleteMessage(deleteParams).promise();
      }
    }
  } catch (error) {
    // Handle any errors that occur during job processing
    console.error(error);
  }
}

new cron.CronJob({
  // Set the cron pattern for when the job should run
  cronTime: "* * * * *", // Run the job every minute
  onTick: processJobs, // Call the processJobs function when the job runs
  start: true // Start the job immediately
});
