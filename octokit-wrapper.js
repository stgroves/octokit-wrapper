import {Octokit, App} from 'octokit';
import sodium from 'libsodium-wrappers';

export default class OctokitWrapper {
    static #appOctokit;
    static #userOctokit;
    static #sodium;

    static #accessToken;

    static #HEADER = {accept: 'application/json'};
    static #OAUTH_URL = 'POST https://github.com/login/oauth/access_token';

    static async getOrCreateAppOctokit(appID = null, pem = null, installationID = null) {
        if (!OctokitWrapper.#appOctokit) {
            if (!appID) {
                console.error('App ID is missing');
                process.exit(1);
            }

            if (!installationID) {
                console.error('Installation ID not found!');
                process.exit(1);
            }

            if (!pem) {
                console.error('PEM not found!');
                process.exit(1);
            }

            const app = new App({appId: appID, privateKey: pem});
            OctokitWrapper.#appOctokit = await app.getInstallationOctokit(installationID);
        }

        return OctokitWrapper.#appOctokit;
    }

    static async getOrCreateUserOctokit(accessToken) {
        if (!OctokitWrapper.#userOctokit && !accessToken) {
            console.error('No access token provided');
            process.exit(1);
        }

        if (!OctokitWrapper.#userOctokit || accessToken !== OctokitWrapper.#accessToken) {
            OctokitWrapper.#userOctokit = await new Octokit({auth: accessToken});
            OctokitWrapper.#accessToken = accessToken;
        }

        return OctokitWrapper.#userOctokit;
    }

    static async getAccessTokenFromCode(clientID, clientSecret, code) {
        if (!clientID) {
            console.error('clientID not found!');
            process.exit(1);
        }

        if (!clientSecret) {
            console.error('clientSecret not found!');
            process.exit(1);
        }

        if (!code) {
            console.error('code not found!');
            process.exit(1);
        }

        try {
            console.log('Creating initial OAuth token.');

            const response = await OctokitWrapper.requestAsApp(
                OctokitWrapper.#OAUTH_URL,
                {
                    client_id: clientID,
                    client_secret: clientSecret,
                    code,
                    headers: OctokitWrapper.#HEADER
                }
            );

            return [response.access_token, response.refresh_token];
        } catch (error) {
            console.error('Token creation failed:', error.message);
            process.exit(1);
        }
    }

    static async getAccessTokenFromRefreshToken(clientID, clientSecret, refreshToken) {
        if (!clientID) {
            console.error('clientID not found!');
            process.exit(1);
        }

        if (!clientSecret) {
            console.error('clientSecret not found!');
            process.exit(1);
        }

        if (!refreshToken) {
            console.error('refreshToken not found!');
            process.exit(1);
        }

        try {
            console.log('Refreshing OAuth token.');

            const response = await OctokitWrapper.requestAsApp(
                OctokitWrapper.#OAUTH_URL,
                {
                    client_id: clientID,
                    client_secret: clientSecret,
                    refresh_token: refreshToken,
                    grant_type: 'refresh_token',
                    headers: OctokitWrapper.#HEADER
                }
            );

            return [response.data.access_token, response.data.refresh_token];
        } catch (error) {
            console.error('Token refresh failed:', error.message);
            process.exit(1);
        }
    }

    static async getRepoID(owner, repo) {
        try {
            const octokit = await OctokitWrapper.getOrCreateAppOctokit();
            const response = await octokit.rest.repos.get({owner, repo});

            return response.data.id;
        } catch (e) {
            console.error('Error fetching repo:', e);
            process.exit(1);
        }
    }

    /**
     *
     * @param {String} owner
     * @param {String} repo
     * @param {OctokitWrapper~SecretData[]} secrets
     * @returns {Promise<void>}
     */
    static async updateSecrets(owner, repo, secrets) {
        if (!OctokitWrapper.#sodium) {

            console.log('Preparing sodium');

            await sodium.ready;

            console.log('sodium ready');

            OctokitWrapper.#sodium = sodium;
        }

        const octokit = await OctokitWrapper.getOrCreateAppOctokit();
        const {data: publicKey} = await octokit.rest.actions.getRepoPublicKey({owner, repo});

        console.log(`Attempting to store secrets for ${repo}.`);


        for (const secret of secrets) {
            await octokit.rest.actions.createOrUpdateRepoSecret(
                {
                    owner,
                    repo,
                    secret_name: secret.key,
                    encrypted_value: await OctokitWrapper.encrypt(publicKey.key, secret.value),
                    key_id: publicKey.key_id
                }
            );
        }
    }

    static async requestAsApp(restQuery, queryObject, propertyName = null) {
        const octokit = await OctokitWrapper.getOrCreateAppOctokit();
        return await OctokitWrapper.#request(octokit, restQuery, queryObject, propertyName);
    }

    static async requestAsUser(restQuery, queryObject, propertyName = null) {
        const octokit = await OctokitWrapper.getOrCreateUserOctokit();
        return await OctokitWrapper.#request(octokit, restQuery, queryObject, propertyName);
    }

    static async #request(octokit, restQuery, queryObject, propertyName) {
        const MAX_RETRIES = 3; // Set retry count
        const RETRY_DELAY_MS = 2000; // 2 seconds

        let attempt = 1;

        while (attempt <= MAX_RETRIES) {
            try {
                const response = await octokit.request(restQuery, queryObject);

                if (!propertyName)
                    return response.data;

                return response.data[propertyName];
            } catch (error) {
                console.error(`Attempt ${attempt} failed:`, error.response ? error.response.data : error.message);

                if (attempt >= MAX_RETRIES) {
                    console.error(`Failed after ${MAX_RETRIES} attempts. Exiting.`);
                    process.exit(1);
                }

                const expRetry = Math.pow(RETRY_DELAY_MS, attempt); //2, 4, 8

                console.log(`Retrying in ${expRetry / 1000} seconds...`);
                await new Promise((res) => setTimeout(res, expRetry));
                attempt++;
            }
        }
    }

    static encrypt(publicKey, token) {
        const binaryKey = OctokitWrapper.#sodium.from_base64(
            publicKey,
            OctokitWrapper.#sodium.base64_variants.ORIGINAL
        );
        const binaryToken = OctokitWrapper.#sodium.from_string(token);

        const encrypted = OctokitWrapper.#sodium.crypto_box_seal(binaryToken, binaryKey);

        return Promise.resolve(
            OctokitWrapper.#sodium.to_base64(
                encrypted,
                OctokitWrapper.#sodium.base64_variants.ORIGINAL
            )
        );
    }
}
/**
 * @typedef {Object} OctokitWrapper~SecretData
 * @property {String} key
 * @property {String} value
 */