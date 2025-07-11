import {Octokit, App} from 'octokit';
import sodium from 'libsodium-wrappers';
import { createSodiumProvider } from './sodium-provider.js';

const HEADER = {accept: 'application/json'};
const OAUTH_URL = 'POST https://github.com/login/oauth/access_token';

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
 * Gets a ready-to-use sodium instance.
 * @type {GetSodium}
 */
const getSodium = createSodiumProvider(sodium);

/**
 * Creates a request data object.
 * @callback CreateRequest
 * @param {string} restQuery
 * @param {Object} queryObject
 * @returns {RequestBuilder<import('@octokit/core').Octokit>}
 */
const createRequest = (restQuery, queryObject) => {
    const MAX_RETRIES = 3; // Set retry count
    const INTERVAL = 2000; // 2 seconds

    const retryConfig = {
        maxRetries: MAX_RETRIES,
        interval: INTERVAL
    }

    const initialState = {
        restQuery,
        queryObject,
        propertyName: null
    };

    const buildRequest = (state, retryConfig) => {
        return {
            withRetries: maxRetries => buildRequest(state, { ...retryConfig, maxRetries }),
            withInterval: interval => buildRequest(state, { ...retryConfig, interval }),
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
    const { maxRetries, interval } = retryConfig;

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
 * @callback Request
 * @param {FullOctokit} octokit - An authenticated Octokit instance.
 * @param {{ restQuery: string, queryObject: object, propertyName?: string|null }} requestData - The request
 *     configuration.
 * @returns {Promise<any>} The response data or a specific property from the response.
 * @throws {Error} If a propertyName is specified but not found in the response.
 */
const request = async (octokit, requestData) => {
    const response = await octokit.request(requestData.restQuery, requestData.queryObject);

    const data = requestData.propertyName ? response.data?.[requestData.propertyName] : response.data;

    if (requestData.propertyName && data === undefined)
        throw new Error(`Property "${requestData.propertyName}" not found in response.`);

    return data;
}

/**
 * @typedef {(octokit: FullOctokit, owner: string, repo: string, secrets: SecretData[]) => Promise<void>} UpdateSecrets
 */

/**
 * Updates GitHub Actions secrets for a specific repository.
 * @type {UpdateSecrets}
 */
async function updateSecrets (octokit, owner, repo, secrets) {
    const {data: {key, key_id}} = await octokit.rest.actions.getRepoPublicKey({owner, repo});

    console.log(`Attempting to store secrets for ${repo}.`);

    for (const secret of secrets) {
        await octokit.rest.actions.createOrUpdateRepoSecret(
            {
                owner,
                repo,
                secret_name: secret.key,
                encrypted_value: await encrypt(key, secret.value),
                key_id
            }
        );
    }
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
 * @type {OctokitWrapper}
 */
export const OctokitWrapper = Object.freeze({
    updateSecrets,
    getAccessTokenFromRefreshToken,
    getAccessTokenFromCode,
    getRepoID,
    getSodium,
    createUserOctokitProvider,
    createAppOctokitProvider,
    createRequest,
    runWithRetries
});

/**
 * @typedef {Object} OctokitWrapper
 * @property {UpdateSecrets} updateSecrets
 * @property {GetAccessTokenFromRefreshToken} getAccessTokenFromRefreshToken
 * @property {GetAccessTokenFromCode} getAccessTokenFromCode
 * @property {GetRepoID} getRepoID
 * @property {GetSodium} getSodium
 * @property {CreateAppOctokitProvider} createAppOctokitProvider
 * @property {CreateUserOctokitProvider} createUserOctokitProvider
 * @property {CreateRequest} createRequest
 * @property {RunWithRetries} runWithRetries
 */

/**
 * @typedef {() => Promise<typeof import('libsodium-wrappers')>} GetSodium
 */

/**
 * @typedef {Object} OctokitWrapper~SecretData
 * @property {String} key
 * @property {String} value
 */

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
 * @property {(propertyName: string) => RequestBuilder<T>} withProperty
 * @property {(octokit: T) => Promise<*>} runWith
 */

/**
 * @typedef {import('@octokit/core').Octokit & {
 *   rest: import('@octokit/plugin-rest-endpoint-methods').RestEndpointMethods
 * }} FullOctokit
 */