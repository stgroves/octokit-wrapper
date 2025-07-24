// @ts-check

import { Octokit, App } from 'octokit';

import sodium from 'libsodium-wrappers';
import { createSodiumProvider } from './sodium-provider.js';



/**
 * Creates a provider to access Octokit as GitHub App.
 * @callback CreateAppOctokitProvider
 * @param {string} appID
 * @param {string} pem
 * @param {number} installationID
 * @returns {() => Promise<Result<FullOctokit>>}
 */
const createAppOctokitProvider = (appID, pem, installationID) => {
    let cachedOctokit = null;

    return async () => {
        if (cachedOctokit)
            return { success: true, data: cachedOctokit };

        try {
            const app = new App({ appId: appID, privateKey: pem });
            cachedOctokit = await app.getInstallationOctokit(installationID);
            return { success: true, data: cachedOctokit };
        } catch (e) {
            console.error(`Failed to create Octokit:`, {
                message: e.message,
                response: e.response?.data,
                stack: e.stack
            });

            return { success: false, error: new Error('Failed to create Octokit.') };
        }
    };
};

/**
 * Creates a provider to access Octokit as a user.
 * @callback CreateUserOctokitProvider
 * @param {string} accessToken - The user's OAuth access token.
 * @returns {() => Promise<Result<FullOctokit>>}
 */
const createUserOctokitProvider = (accessToken) => {
    let cachedOctokit = null;

    return async () => {
        if (cachedOctokit)
            return { success: true, data: cachedOctokit };

        try {
            cachedOctokit = await new Octokit({auth: accessToken});
            return { success: true, data: cachedOctokit };
        } catch (e) {
            console.error(`Failed to create Octokit:`, {
                message: e.message,
                response: e.response?.data,
                stack: e.stack
            });

            return { success: false, error: new Error('Failed to create Octokit.') };
        }
    }
}

/**
 * Generates an access token using the OAuth code.
 * @callback GetAccessTokenFromCode
 * @param {FullOctokit} octokit - An Octokit instance to perform the request.
 * @param {string} clientID - OAuth App client ID.
 * @param {string} clientSecret - OAuth App client secret.
 * @param {string} code - The temporary code received during the OAuth callback.
 * @returns {Promise<Result<{ accessToken: string, refreshToken: string }>>}
 */
const getAccessTokenFromCode = async (octokit, clientID, clientSecret, code) => {
    try {
        console.log('Creating initial OAuth token.');

        const response = await createRequest(
            OAUTH_URL,
            {
                client_id: clientID,
                client_secret: clientSecret,
                code,
                headers: HEADER
            }
        ).runWith(octokit);

        return {
            success: true,
            data: { accessToken: response.data.access_token, refreshToken: response.data.refresh_token }
        };
    } catch (e) {
        console.error(`Failed to create token:`, {
            message: e.message,
            response: e.response?.data,
            stack: e.stack
        });

        return { success: false, error: new Error('Failed to create token.') };
    }
}

/**
 * Generates an access token using the refresh token.
 * @callback GetAccessTokenFromRefreshToken
 * @param {FullOctokit} octokit - An Octokit instance to perform the request.
 * @param {string} clientID - OAuth App client ID.
 * @param {string} clientSecret - OAuth App client secret.
 * @param {string} refreshToken - The refresh token associated with the access token.
 * @returns {Promise<Result<{ accessToken: string, refreshToken: string }>>}
 */
const getAccessTokenFromRefreshToken = async (octokit, clientID, clientSecret, refreshToken) => {
    try {
        console.log('Refreshing OAuth token.');

        const response = await createRequest(
            OAUTH_URL,
            {
                client_id: clientID,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
                headers: HEADER
            }
        ).runWith(octokit);

        return {
            success: true,
            data: { accessToken: response.data.access_token, refreshToken: response.data.refresh_token }
        };
    } catch (e) {
        console.error(`Failed to refresh token:`, {
            message: e.message,
            response: e.response?.data,
            stack: e.stack
        });

        return { success: false, error: new Error('Failed to refresh token.') };
    }
}

/**
 * Gets the repo's numerical ID.
 * @callback GetRepoID
 * @param {FullOctokit} octokit
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<Result<number>>}
 */
const getRepoID = async (octokit, owner, repo) => {
    try {
        const response = await octokit.rest.repos.get({owner, repo});

        return { success: true, data: response.data.id };
    } catch (e) {
        console.error(`Failed to get Repo ID:`, {
            message: e.message,
            response: e.response?.data,
            stack: e.stack
        });

        return { success: false, error: new Error('Failed to get Repo ID.') };
    }
}

/**
 * @typedef {() => Promise<typeof import('libsodium-wrappers')>} GetSodium
 */

/**
 * Gets a ready-to-use sodium instance.
 * @type {GetSodium}
 */
const getSodium = createSodiumProvider(sodium);

/**
 * Creates a request data object.
 * @param {string | Function} restQuery
 * @param {Object} queryObject
 * @returns {RequestBuilder<import('@octokit/core').Octokit>}
 */
const createRequest = (restQuery, queryObject) => {
    const MAX_RETRIES = 3; // Set retry count
    const INTERVAL = 2000; // 2 seconds

    const retryConfig = {
        maxRetries: MAX_RETRIES,
        interval: INTERVAL,
        stopRetries: (error) => [error.status === 404, error]
    }

    const initialState = {
        restQuery,
        queryObject,
        propertyName: null
    };

    const buildRequest = (state, retryConfig) => {
        return {
            withRetries: maxRetries => {
                if (typeof maxRetries !== 'number')
                    throw new Error('maxRetries must be a number!');

                return buildRequest(state, { ...retryConfig, maxRetries });
            },
            withInterval: interval => {
                if (typeof interval !== 'number')
                    throw new Error('interval must be a number!');

                return buildRequest(state, { ...retryConfig, interval })
            },
            /**
             * @param {RetryBreaker} callback
             * @returns {RequestBuilder<import('@octokit/core').Octokit>}
             */
            withRetryBreaker: callback => {
                if (typeof callback !== 'function')
                    throw new Error('callback must be a function!');

                return buildRequest(state, { ...retryConfig, stopRetries: callback })
            },
            /**
             * @param {{maxRetries: number, interval: number, stopRetries: RetryBreaker}} config
             * @return {RequestBuilder<import('@octokit/core').Octokit>}
             */
            withRetryConfig: config => {


                return buildRequest(state, config)
            },
            withProperty: propertyName => buildRequest({ ...state, propertyName }, retryConfig),
            runWith: octokit => attemptRequest(octokit, state, retryConfig)
        };
    }

    return buildRequest(initialState, retryConfig);
}

/**
 * Executes a callback with retry logic and exponential backoff.
 * @callback RunWithRetries
 * @template T
 * @param {() => Promise<T>} callback - The async operation to retry on failure.
 * @param {{ maxRetries: number, interval: number }} retryConfig - Retry behaviour configuration.
 * @returns {Promise<Result<T>>} - Result object containing either the successful data or an error.
 */
const runWithRetries = async (callback, retryConfig) => {
    const { maxRetries, interval, stopRetries } = retryConfig;

    let attempt = 1;

    while (attempt <= maxRetries) {
        try {
            return { success: true, data: await callback() };
        } catch (e) {
            console.error(`Attempt ${attempt} failed:`, {
                message: e.message,
                response: e.response?.data,
                stack: e.stack
            });

            const [shouldStop, error] = stopRetries(e);

            if (shouldStop)
                return { success: false, error };

            if (attempt >= maxRetries)
                return { success: false, error: new Error(`Request failed after ${maxRetries} attempts`) };

            const delay = interval * 2 ** (attempt - 1);

            console.log(`Retrying in ${delay / 1000} seconds...`);
            await new Promise((res) => setTimeout(res, delay));
            attempt++;
        }
    }
}

/**
 * Attempts a typed Octokit request using a retry wrapper.
 * @callback AttemptRequest
 * @param {FullOctokit} octokit - An authenticated Octokit instance.
 * @param {{ restQuery: string, queryObject: object, propertyName?: string|null }} requestData - The request config.
 * @param {{ maxRetries: number, interval: number }} retryConfig - Retry behaviour configuration.
 * @returns {Promise<Result<any>>} - Result object wrapping the request response or error.
 */
const attemptRequest = async (octokit, requestData, retryConfig) => {
    return runWithRetries(() => request(octokit, requestData), retryConfig);
}

/**
 * Executes a GitHub REST request via Octokit with optional property extraction.
 *
 * @param {FullOctokit} octokit - An authenticated Octokit instance.
 * @param {{ restQuery: string | function, queryObject: object, propertyName?: string|null }} requestData - The request
 *     configuration.
 * @returns {Promise<any>} The response data or a specific property from the response.
 * @throws {Error} If a propertyName is specified but not found in the response.
 */
const request = async (octokit, requestData) => {
    const response = typeof requestData.restQuery === 'function' ?
        await requestData.restQuery.call(octokit.rest, requestData.queryObject) :
        await octokit.request(requestData.restQuery, requestData.queryObject);

    const data = requestData.propertyName ? response.data?.[requestData.propertyName] : response.data;

    if (requestData.propertyName && data === undefined)
        throw new Error(`Property "${requestData.propertyName}" not found in response.`);

    return data;
}

/**
 * Encrypts a token using a given public key via libsodium sealed boxes.
 *
 * @param {string} publicKey - The base64-encoded public key from GitHub Actions.
 * @param {string} token - The plaintext token to encrypt.
 * @returns {Promise<string>} The encrypted value, base64-encoded.
 */
const encrypt = async (publicKey, token) => {
    const sodium = await getSodium();

    const binaryKey = sodium.from_base64(
        publicKey,
        sodium.base64_variants.ORIGINAL
    );
    const binaryToken = sodium.from_string(token);

    const encrypted = sodium.crypto_box_seal(binaryToken, binaryKey);

    return sodium.to_base64(
        encrypted,
        sodium.base64_variants.ORIGINAL
    );
}

/**
 * Updates GitHub Actions secrets for a specific repository.
 * @param {FullOctokit} octokit
 * @param {String} owner
 * @param {String} repo
 * @param {OctokitWrapper~SecretData[]} secrets
 * @returns {Promise<void>}
 */
async function updateSecrets (octokit, owner, repo, secrets) {
    const {data: {key, key_id}} = await octokit.rest.actions.getRepoPublicKey({owner, repo});

    console.log(`Attempting to store secrets for ${repo}.`);

    for (const secret of secrets) {
        await createRequest(octokit.rest.actions.createOrUpdateRepoSecret,
            {
                owner,
                repo,
                secret_name: secret.key,
                encrypted_value: await encrypt(key, secret.value),
                key_id
            }
        ).runWith(octokit);
    }
}

async function getRepoByID(octokit, repoID) {
    return createRequest(
        'GET /repositories/{repository_id}',
        {repository_id: repoID}
    ).runWith(octokit);
}

const getFile = async (octokit, owner, repo, path, {branch = 'main', getRaw = false} = {}) => {
    const response = await createRequest(
        octokit.rest.repos.getContent,
        {
            owner,
            repo,
            path,
            ref: branch, // Specify the branch name
        }
    ).runWith(octokit);

    const processedFile = Buffer.from(response?.content, "base64");

    return {
        data: response,
        processedFile: getRaw ? processedFile : processedFile.toString("utf-8")
    };
}

const createOrUpdateFile = async (octokit, owner, repo, path, content, commit, branch = 'main') => {
    // Get the file's current SHA if it exists
    let foundSha;
    try {
        const { data } = await getFile(octokit, owner, repo, path, {branch});
        foundSha = data.sha;
    } catch (error) {
        if (error.status !== 404) {
            throw error;
        }
    }

    const filePackage = {
        owner,
        repo,
        path,
        message: commit,
        content: Buffer.from(content).toString('base64'),
        branch
    }

    // Create or update the file
    return createRequest(
        octokit.repos.createOrUpdateFileContents,
        foundSha ? {...filePackage, sha: foundSha} : filePackage
    ).runWith(octokit);
}

const getRef = async (octokit, owner, repo, ref) => {
    return createRequest(
        octokit.rest.git.getRef,
        {owner, repo, ref},
    ).runWith(octokit);
}

const getBranch = async (octokit, owner, repo, branchName) => {
    return getRef(octokit, owner, repo, `heads/${branchName}`);
}

const getTag = async (octokit, owner, repo, tagName) => {
    return getRef(octokit, owner, repo, `tags/${tagName}`);
}

async function ensureBranchExists(octokit, owner, repo, branchName, baseBranch = 'main') {
    try {
        await getBranch(octokit, owner, repo, branchName);
        console.log(`Branch ${branchName} already exists.`);
    } catch (error) {
        if (error.status === 404) {
            console.log(`Branch ${branchName} does not exist. Creating it...`);

            // Get the SHA of the base branch
            const baseRef = `heads/${baseBranch}`;
            const baseBranchData = await octokit.rest.git.getRef({
                owner,
                repo,
                ref: baseRef,
            });
            const baseSha = baseBranchData.data.object.sha;

            // Create the new branch
            await octokit.rest.git.createRef({
                owner,
                repo,
                ref: `refs/heads/${branchName}`,
                sha: baseSha,
            });
            console.log(`Branch ${branchName} created successfully.`);
        } else {
            console.error(`Error checking branch: ${error.message}`);
        }
    }
}



/**
 * @typedef {Object} OctokitWrapper
 * @property {typeof updateSecrets} updateSecrets
 * @property {GetAccessTokenFromRefreshToken} getAccessTokenFromRefreshToken
 * @property {GetAccessTokenFromCode} getAccessTokenFromCode
 * @property {GetRepoID} getRepoID
 * @property {GetSodium} getSodium
 * @property {CreateAppOctokitProvider} createAppOctokitProvider
 * @property {CreateUserOctokitProvider} createUserOctokitProvider
 * @property {RunWithRetries} runWithRetries
 */

/**
 * @type {OctokitWrapper}
 */
const OctokitWrapper = Object.freeze({
    updateSecrets,
    getAccessTokenFromRefreshToken,
    getAccessTokenFromCode,
    getRepoID,
    getSodium,
    createUserOctokitProvider,
    createAppOctokitProvider,
    createRequest,
    runWithRetries,
    getRepoByID,
    createOrUpdateFile,
    getFile,
    getBranch,
    getTag,
    ensureBranchExists
});

export { OctokitWrapper };

/**
 * @template T
 * @typedef {Object} ResultSuccess<T>
 * @property {true} success
 * @property {T} data
 */

/**
 * @typedef {Object} ResultError
 * @property {false} success
 * @property {Error} error
 */

/**
 * @template T
 * @typedef {ResultSuccess<T> | ResultError} Result<T>
 */

/**
 * @template T
 * @typedef {Object} RequestBuilder
 * @property {(maxRetries: number) => RequestBuilder<T>} withRetries
 * @property {(interval: number) => RequestBuilder<T>} withInterval
 * @property {(callback: RetryBreaker) => RequestBuilder<T>} withRetryBreaker
 * @property {(propertyName: string) => RequestBuilder<T>} withProperty
 * @property {(octokit: T) => Promise<*>} runWith
 */

/**
 * @typedef {import('@octokit/core').Octokit & {
 *   rest: import('@octokit/plugin-rest-endpoint-methods').RestEndpointMethods
 * }} FullOctokit
 */

/**
 * @typedef {Object} OctokitWrapper~SecretData
 * @property {String} key
 * @property {String} value
 */

/**
 * @callback RetryBreaker
 * @param {Error} error
 * @returns {[Boolean, Error]}
 */