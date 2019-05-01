const https = require('https');
const crypto = require('crypto');
const yaml = require('yamljs');
const {PubSub} = require('@google-cloud/pubsub');
const {Storage} = require('@google-cloud/storage');
const kms = require('@google-cloud/kms');

const pubsub = new PubSub();
const storage = new Storage();
const kmsClient = new kms.KeyManagementServiceClient();
const secretBucket = storage.bucket(process.env.SECRETS_BUCKET_NAME);

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

// Read file
function readFile(file) {
  return new Promise((resolve, reject) => {
    const fileReader = file.createReadStream();
    const buffers = [];
    fileReader.on('data', function(data) {
      buffers.push(data);
    }).on('end', function() {
      resolve(Buffer.concat(buffers));
    }).on('error', (error) => {
      reject(error);
    });
  });
}

// Retrieve a secret from Key Vault
async function getSecret(name) {

  const file = secretBucket.file(name);

  try {
    if (process.env.DEBUG)
      console.log(`Got secret file from bucket ${name}`);

    const cryptoname = kmsClient.cryptoKeyPath(
      process.env.PROJECT_ID,
      process.env.LOCATION,
      process.env.KEYRING_ID,
      process.env.CRYPTOKEY_ID
    );

    const fileContents = await readFile(file);

    // Decrypts the file using the specified crypto key
    //const b64secret = Buffer.from(fileContents).toString('base64');
    const [result] = await kmsClient.decrypt({name: cryptoname, ciphertext: Buffer.from(fileContents)});
    return Buffer.from(result.plaintext, 'base64').toString('utf8').trim();
  } catch(err) {
    if (process.env.DEBUG)
      console.log('Error retrieving secret', err);
    return false;
  }
}

// Verification function to check if it is actually GitHub who is POSTing here
async function verifyGitSecret(headers, stringBody) {
  if (process.env.DEBUG) {
    // eslint-disable-next-line no-console
    console.log('verifying git secret...');
  }
  if (headers['x-hub-signature']) {
    // Get secret from secret store
    const gitSecret = await getSecret('GitHookSecret');
    if (gitSecret) {
      try {
        const signature = `sha1=${crypto.createHmac('sha1', gitSecret).update(stringBody).digest('hex')}`;
        return crypto.timingSafeEqual(Buffer.from(headers['x-hub-signature']), Buffer.from(signature));
      } catch (e) {
        return false;
      }
    }
  }
  return false;
}

// Verification function to check if the CLI request has the right API Key
async function verifyApiKey(headers) {
  if (process.env.DEBUG) {
    // eslint-disable-next-line no-console
    console.log('verifying api key...');
  }
  if (headers['x-api-key']) {
    // Get secret from secret store
    const apiKey = await getSecret('ApiKey');
    if (apiKey === headers['x-api-key']) {
      return true;
    }
  }
  return false;
}

exports.handler = async (request, response) => {
    // if debug is enabled, show the full received request
    if (process.env.DEBUG) {
      // eslint-disable-next-line no-console
      console.log(request.body);
      console.log(request.headers);
    }
    // check if we have body property for the received request
    if (request.body != null) {
      const body = request.body;
  
      if (body.deployment) {
        // first let's validate the github signature
        if (!await verifyGitSecret(request.headers, request.rawBody)) {
          response.status(403).send(JSON.stringify({ msg: 'Github signature validation failed' }));
          return;
        }
  
        // send message to queue
        const event  = {
            remoteUrl: body.repository.clone_url,
            commitRef: body.deployment.ref,
            deploymentId: body.deployment.id,
            environment: body.deployment.environment,
        };
  
        //const dataBuffer = Buffer.from(JSON.stringify(event), 'utf-8');

        // Publishes the message and prints the messageID on console
        try {
          const messageId = await pubsub.topic(`${process.env.CLUSTER}-deploy`).publishJSON(event);
          if (process.env.DEBUG)
            console.log(`Message ${messageId} published`);
          response.status(200).send(JSON.stringify({ msg: 'Deployment successfully started' }));
        } catch(e) {
          if (process.env.DEBUG)
            console.log(e);
          response.status(500).send(JSON.stringify({ error: 'Hook execution failed' }));
        }
      // this is just a test hook from github
      } else if (body.hook && body.hook.type === 'Repository') {
        if (await verifyGitSecret(request.headers, request.rawBody)) {
          response.status(200).send(JSON.stringify({ msg: 'Github test hook received' }));
        } else {
          response.status(403).send(JSON.stringify({ msg: 'Github signature validation failed' }));
        }
        return;
      } else if (body.repository || (body.remoteUrl && body.commitRef && body.environment)) {
        let owner = '';
        let repo = '';
        let branch = '';
        let gitToken = '';
  
        // depending on if this is direct from CLI or from hook, we need to do different parsing
        // first option is github hook
        if (body.repository) {
          // first let's validate the github signature
          if (!await verifyGitSecret(request.headers, request.rawBody)) {
            response.status(403).send(JSON.stringify({ msg: 'Github signature validation failed' }));
            return;
          }
          owner = body.repository.owner.login;
          repo = body.repository.name;
          branch = body.repository.default_branch;
        } else {
          if (!await verifyApiKey(request.headers)) {
            response.status(403).send(JSON.stringify({ msg: 'API KEY validation failed' }));
            return;
          }
  
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
          gitToken = await getSecret('GitToken');
          if (gitToken) {
            stackYamlOptions.headers.Authorization = 'token '.concat(gitToken);
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
        try {
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
    
            if (gitToken) {
              deploymentOptions.headers.Authorization = 'Bearer '.concat(gitToken);
            }

            if (process.env.DEBUG) {
              // eslint-disable-next-line no-console
              console.log(deploymentOptions);
            }
    
            await doRequest(deploymentOptions, postData);
    
            response.status(200).send(JSON.stringify({ msg: 'Deployment successfully triggered' }));
          }
        } catch(e) {
          if (process.env.DEBUG)
            console.log(e);
          response.status(500).send(JSON.stringify({ error: 'Hook execution failed' }));
        }
      } else {
        response.status(422).send(JSON.stringify({ error: 'Request is missing some parameter' }));
      }
    }
};
