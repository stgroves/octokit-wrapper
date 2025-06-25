import {Octokit, App} from 'octokit';
import sodium from 'libsodium-wrappers';
import { createSodiumProvider } from './sodium-provider.js';

const HEADER = {accept: 'application/json'};
const OAUTH_URL = 'POST https://github.com/login/oauth/access_token';

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

const getAccessTokenFromCode = async (octokit, clientID, clientSecret, code) => {
    try {
        console.log('Creating initial OAuth token.');

        const response = await request(
            octokit,
            OAUTH_URL,
            {
                client_id: clientID,
                client_secret: clientSecret,
                code,
                headers: HEADER
            }
        );

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

const getSodium = createSodiumProvider(sodium);

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
 * @template T
 * @param {() => Promise<T>} callback
 * @param {{ maxRetries: number, interval: number }} retryConfig
 * @returns {Promise<{ success: true, data: T } | { success: false, error: Error }>}
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

const attemptRequest = async (octokit, requestData, retryConfig) => {
    return runWithRetries(() => request(octokit, requestData), retryConfig);
}

const request = async (octokit, requestData) => {
    const response = await octokit.request(requestData.restQuery, requestData.queryObject);

    const data = requestData.propertyName ? response.data?.[requestData.propertyName] : response.data;

    if (requestData.propertyName && data === undefined)
        throw new Error(`Property "${requestData.propertyName}" not found in response.`);

    return data;
}

/**
 *
 * @param {Object} octokit
 * @param {String} owner
 * @param {String} repo
 * @param {OctokitWrapper~SecretData[]} secrets
 * @returns {Promise<void>}
 */
const updateSecrets = async (octokit, owner, repo, secrets) => {
    const {data: publicKey} = await octokit.rest.actions.getRepoPublicKey({owner, repo});

    console.log(`Attempting to store secrets for ${repo}.`);

    for (const secret of secrets) {
        await octokit.rest.actions.createOrUpdateRepoSecret(
            {
                owner,
                repo,
                secret_name: secret.key,
                encrypted_value: await encrypt(publicKey.key, secret.value),
                key_id: publicKey.key_id
            }
        );
    }
}

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

export const OctokitWrapper = {
    updateSecrets,
    getAccessTokenFromRefreshToken,
    getAccessTokenFromCode,
    getRepoID,
    getSodium,
    createUserOctokitProvider,
    createAppOctokitProvider,
    createRequest,
    runWithRetries
}

/**
 * @typedef {Object} OctokitWrapper~SecretData
 * @property {String} key
 * @property {String} value
 */