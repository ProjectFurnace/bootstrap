const AWS = require('aws-sdk');
const https = require('https');
const crypto = require('crypto');
const yaml = require('yamljs');

const sns = new AWS.SNS({ apiVersion: '2010-03-31' });
const sm = new AWS.SecretsManager({ apiVersion: '2017-10-17' });

// Do HTTPS request
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

// Retrieve a secret from AWS Secret Manager
function getSM(name) {
  const params = {
    SecretId: name,
  };

  return sm.getSecretValue(params).promise();
}

// Verification function to check if it is actually GitHub who is POSTing here
async function verifyGitSecret(headers, stringBody) {
  if (headers['x-hub-signature']) {
    // Get secret from secret store
    const gitSecret = await getSM(process.env.FURNACE_INSTANCE.concat('/GitHookSecret'));
    if (gitSecret.SecretString) {
      const signature = `sha1=${crypto.createHmac('sha1', gitSecret).update(stringBody).digest('hex')}`;
      return crypto.timingSafeEqual(Buffer.from(headers['x-hub-signature']), Buffer.from(signature));
    }
  }
  return false;
}

exports.handler = async (event, context, callback) => {
  // if debug is enabled, show the full received event
  if (process.env.DEBUG) {
    // eslint-disable-next-line no-console
    console.log(event);
  }
  // check if we have body property for the received event
  if (event.body != null) {
    const body = JSON.parse(event.body);

    if (body.deployment) {
      // first let's validate the github signature
      if (!verifyGitSecret(event.headers, event.body)) {
        callback(null, { statusCode: 403, body: JSON.stringify({ msg: 'Github signature validation failed' }) });
      }

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
    // this is just a test hook from github
    } else if (body.hook && body.hook.type === 'Repository') {
      if (verifyGitSecret(event.headers, event.body)) {
        callback(null, { statusCode: 200, body: JSON.stringify({ msg: 'Github test hook received' }) });
      } else {
        callback(null, { statusCode: 403, body: JSON.stringify({ msg: 'Github signature validation failed' }) });
      }
    } else if (body.repository || (body.remoteUrl && body.commitRef && body.environment)) {
      let owner = '';
      let repo = '';
      let branch = '';
      let gitToken = '';

      // depending on if this is direct from CLI or from hook, we need to do different parsing
      // first option is github hook
      if (body.repository) {
        // first let's validate the github signature
        if (!verifyGitSecret(event.headers, event.body)) {
          callback(null, { statusCode: 403, body: JSON.stringify({ msg: 'Github signature validation failed' }) });
        }
        owner = body.repository.owner.login;
        repo = body.repository.name;
        branch = body.repository.default_branch;
      } else {
        const parts = body.remoteUrl.split('/');

        [,,, owner, repo] = parts;
        branch = body.commitRef;
      }

      const stackYamlOptions = {
        host: 'raw.githubusercontent.com',
        // eslint-disable-next-line prefer-template
        path: '/' + owner + '/' + repo + '/' + branch + '/stack.yaml',
        method: 'GET',
        headers: {
          'User-Agent': 'Project Furnace',
        },
      };


      try {
        gitToken = await getSM(process.env.FURNACE_INSTANCE.concat('/GitToken'));
        if (gitToken.SecretString) {
          stackYamlOptions.headers.Authorization = 'token '.concat(gitToken.SecretString);
        }
      } catch (e) {
        if (process.env.DEBUG) {
          // eslint-disable-next-line no-console
          console.log('Error fetching GIT token from Secrets Manager', e);
        }
      }

      if (process.env.DEBUG) {
        // eslint-disable-next-line no-console
        console.log(stackYamlOptions);
      }

      // parse stack.yaml file
      const stackYaml = await doRequest(stackYamlOptions);
      const stack = yaml.parse(stackYaml);
      const { environments } = stack;

      if (environments) {
        const deploymentData = { owner, repo, ref: 'master' };

        deploymentData.environment = (body.repository ? environments[0] : body.environment);

        const postData = JSON.stringify(deploymentData);

        const deploymentOptions = {
          host: 'api.github.com',
          // eslint-disable-next-line prefer-template
          path: '/repos/' + owner + '/' + repo + '/deployments',
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'Content-type': 'application/json',
            'Content-Length': postData.length,
            'User-Agent': 'Project Furnace',
          },
        };

        if (gitToken.SecretString) {
          deploymentOptions.headers.Authorization = 'Bearer '.concat(gitToken.SecretString);
        }

        await doRequest(deploymentOptions, postData);

        callback(null, { statusCode: 200, body: JSON.stringify({ msg: 'Deployment successfully triggered' }) });
      }
    }
    callback(null, { statusCode: 422, body: JSON.stringify({ error: 'Request is missing some parameter' }) });
  }
};
