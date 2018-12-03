const AWS = require('aws-sdk');

const sns = new AWS.SNS({ apiVersion: '2010-03-31' });

exports.handler = async (event, context, callback) => {
  if (event.body != null) {
    const body = JSON.parse(event.body);

    if (body.remoteUrl && body.commitRef) {
      const params = {
        Message: {
          remoteUrl: body.remoteUrl,
          commitRef: body.commitRef,
        },
        TopicArn: process.env.TOPIC,
        MessageStructure: 'JSON',
      };

      // Create promise and SNS service object
      const publishTextPromise = sns.publish(params).promise();

      // Handle promise's fulfilled/rejected states
      publishTextPromise.then((data) => {
        if (process.env.DEBUG) {
          // eslint-disable-next-line no-console
          console.log(`Message ${params.Message} send sent to the topic ${params.TopicArn} with ID ${data.MessageId}`);
        }
        callback(null, { statusCode: 200, body: 'Successful' });
      }).catch((err) => {
        if (process.env.DEBUG) {
          // eslint-disable-next-line no-console
          console.error(err, err.stack);
        }
        callback(err);
      });
    }
  }
};
