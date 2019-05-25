const targz = require('targz');
const fsutils = require("@project-furnace/fsutils");
const {Storage} = require('@google-cloud/storage');
const kms = require('@google-cloud/kms');
const {auth} = require('google-auth-library');
const {google} = require("googleapis");
const gitUtils = require("@project-furnace/gitutils");
const path = require("path");
const randomstring = require("randomstring");

const storage = new Storage();

exports.handler = async (inputEvent, callback) => {
  if (process.env.DEBUG) {
    // eslint-disable-next-line no-console
    console.log(inputEvent);
  }

  const event = inputEvent.data ? JSON.parse( Buffer.from(inputEvent.data, 'base64').toString() ) : {};

  if (process.env.DEBUG) {
    // eslint-disable-next-line no-console
    console.log(event);
  }

  const authClient = await getAuthClient();

  google.options({ auth: authClient });

  const rand = randomstring.generate({ length: 6, capitalization: 'lowercase' });
  const objectName = `${process.env.FURNACE_INSTANCE}-${rand}.tar.gz`

  await upload(event, objectName);

  // const builds = await google.cloudbuild("v1").projects.builds.list({ projectId: "furnace-scratch" });

  // const projectId = await auth.getProjectId();

  //   steps:
  // - name: gcr.io/$PROJECT_ID/pulumi-node
  //   entrypoint: /bin/sh
  //   args:
  //   - '-c'
  //   - 'yarn install && pulumi login && pulumi stack select <stack_name> && pulumi preview'
  //   env: ["PULUMI_ACCESS_TOKEN=$_INSECURE_SUBSTITUTION_PULUMI_ACCESS_TOKEN_FOR_TESTING"]

  const buildResult = await google.cloudbuild("v1").projects.builds.create({
    projectId: process.env.PROJECT_ID,
    requestBody: {
      source: {
        storageSource: {
          bucket: process.env.BUILD_BUCKET,
          object: objectName
        }
      },
      steps: [
        {
          name: "projectfurnace/deploy-gcp:latest",
          entrypoint: "/bin/bash",
          args: [
            "-c",
            "/app/deploy_gcp_local.sh"
          ],
          env: [
            //"FURNACE_LOCAL=1",
            "REPO_DIR=/workspace",
            //"TEMPLATE_REPO_DIR=/app/test/fixtures/templates",
            "STACK_ENV=".concat(event.environment),
            "STACK_REGION=".concat(process.env.LOCATION),
            "DEPLOYMENT_ID=".concat(event.deploymentId.toString()),
            "PLATFORM=".concat(process.env.PLATFORM),
            "BUILD_BUCKET=".concat(process.env.BUILD_BUCKET),
            "FURNACE_INSTANCE=".concat(process.env.FURNACE_INSTANCE),
            "GIT_REMOTE=".concat(event.remoteUrl),
            "GCP_PROJECT=".concat(process.env.PROJECT_ID),
            "SOPS_KMS_ID=".concat(process.env.SOPS_KMS_ID),
            "LOCATION=".concat(process.env.LOCATION),
            "KEYRING_ID=".concat(process.env.KEYRING_ID),
            "CRYPTOKEY_ID=".concat(process.env.CRYPTOKEY_ID),
            "SECRETS_BUCKET_NAME=".concat(process.env.SECRETS_BUCKET_NAME)
          ]
        }
      ]
    }
  });

  console.log(buildResult);
};

async function getAuthClient() {
  const client = await auth.getClient({
    scopes: 'https://www.googleapis.com/auth/cloud-platform'
  });
  return client;
}

function compress(repoDir, destination) {
  return new Promise((resolve, reject) => {
    targz.compress({
      src: repoDir,
      dest: destination
    }, function(err){
        if(err) {
            reject(err);
        } else {
            resolve(destination);
        }
    });  
  })
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
  const kmsClient = new kms.KeyManagementServiceClient();
  const secretBucket = storage.bucket(process.env.SECRETS_BUCKET_NAME);

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

async function upload(data, objectName) {
  const baseDir = fsutils.createTempDirectory();
  const repoDir = path.join(baseDir, process.env.FURNACE_INSTANCE);
  if (!fsutils.exists(repoDir)) fsutils.mkdir(repoDir);

  const gitToken = await getSecret('GitToken');

  await gitUtils.clone(repoDir, data.remoteUrl, process.env.GIT_USERNAME, gitToken);
  await gitUtils.checkout(repoDir, data.commitRef);

  const filename = await compress(repoDir, path.join(baseDir, objectName));

  // const storage = new Storage({
  //   keyFilename: "/Users/danny/.gcloud/keyfile.json",
  //   projectId: "furnace-scratch"
  // });
  /*const storage = new Storage();

  const filename = '/Users/danny/Downloads/gcp.tar.gz';*/

  return storage.bucket(process.env.BUILD_BUCKET).upload(filename, {
    gzip: true,
    metadata: {
      cacheControl: 'public, max-age=31536000',
    },
  });
}