const AWS = require('aws-sdk');
const https = require('https');

const sns = new AWS.SNS({ apiVersion: '2010-03-31' });

function getEnvs(yaml) {
  const pos = yaml.indexOf('environments:');
  if (pos > 0) {
    return yaml.substr(pos + 14).trim().replace(/-| /g, '').split(/\r?\n/);
  }
  return false;
}

function doRequest(options, postData) {
  return new Promise((resolve, reject) => {
    const buffers = [];
    const req = https.request(options, (res) => {
      res.on('data', (buffer) => {
        buffers.push(buffer);
      });

      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) {
          resolve(Buffer.concat(buffers).toString());
        } else {
          reject(Buffer.concat(buffers));
        }
      });
    }).on('error', (error) => {
      reject(error);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

exports.handler = async (event, context, callback) => {
  if (event.body != null) {
    const body = JSON.parse(event.body);

    if (body.deployment) {
      const params = {
        Message: JSON.stringify({
          remoteUrl: body.repository.clone_url,
          commitRef: body.deployment.ref,
          deploymentId: body.deployment.id,
          environment: body.deployment.environment,
        }),
        TopicArn: process.env.TOPIC,
      };

      // Create promise and SNS service object
      const publishTextPromise = sns.publish(params).promise();

      // Handle promise's fulfilled/rejected states
      await publishTextPromise.then((data) => {
        if (process.env.DEBUG) {
          // eslint-disable-next-line no-console
          console.log(`Message ${params.Message} sent to the topic ${params.TopicArn} with ID ${data.MessageId}`);
        }
        callback(null, { statusCode: 200, body: JSON.stringify({ msg: 'Deployment successfully started' }) });
      }).catch((err) => {
        if (process.env.DEBUG) {
          // eslint-disable-next-line no-console
          console.error(err, err.stack);
        }
        callback(null, { statusCode: 500, body: JSON.stringify({ error: 'Something went wrong...' }) });
      });
    } else if (body.hook && body.hook.Type === 'Repository') {
      callback(null, { statusCode: 200, body: JSON.stringify({ msg: 'Test hook received' }) });
    } else if (body.repository || (body.remoteUrl && body.commitRef && body.environment)) {
      const stackYamlOptions = {
        host: 'raw.githubusercontent.com',
        method: 'GET',
        headers: {
          // eslint-disable-next-line prefer-template
          Authorization: 'token ' + process.env.GIT_TOKEN,
          'User-Agent': 'Project Furnace',
        },
      };

      let owner = '';
      let repo = '';

      if (body.repository) {
        // eslint-disable-next-line prefer-template
        stackYamlOptions.path = '/' + body.repository.full_name + '/' + body.repository.default_branch + '/stack.yaml';
      } else {
        const parts = body.remoteUrl.split('/');

        owner = parts[3];
        repo = parts[4];
        // eslint-disable-next-line prefer-template
        stackYamlOptions.path = '/' + owner + '/' + repo + '/' + body.commitRef + '/stack.yaml';
      }

      const stackYaml = await doRequest(stackYamlOptions);

      const environments = getEnvs(stackYaml);

      if (environments) {
        const deploymentData = {
          ref: 'master',
        };

        if (body.repository) {
          // eslint-disable-next-line prefer-template
          deploymentData.owner = body.repository.owner.name;
          deploymentData.repo = body.repository.name;
          deploymentData.environment = environments[0];
        } else {
          // eslint-disable-next-line prefer-template
          deploymentData.owner = owner;
          deploymentData.repo = repo;
          deploymentData.environment = body.environment;
        }

        const postData = JSON.stringify(deploymentData);

        const deploymentOptions = {
          host: 'api.github.com',
          method: 'POST',
          headers: {
            // eslint-disable-next-line prefer-template
            Authorization: 'Bearer ' + process.env.GIT_TOKEN,
            Accept: 'application/vnd.github.v3+json',
            'Content-type': 'application/json',
            'Content-Length': postData.length,
            'User-Agent': 'Project Furnace',
          },
        };

        if (body.repository) {
          // eslint-disable-next-line prefer-template
          deploymentOptions.path = '/repos/' + body.repository.full_name + '/deployments';
        } else {
          // eslint-disable-next-line prefer-template
          deploymentOptions.path = '/repos/' + owner + '/' + repo + '/deployments';
        }

        await doRequest(deploymentOptions, postData);

        callback(null, { statusCode: 200, body: JSON.stringify({ msg: 'Deployment successfully triggered' }) });
      }
    }
    callback(null, { statusCode: 422, body: JSON.stringify({ error: 'Request is missing some parameter' }) });
  }
};
