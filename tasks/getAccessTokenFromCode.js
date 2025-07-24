import { OAUTH_URL } from '../constants.js'

const getAccessTokenFromCode = async (octokit, clientID, clientSecret, code) => {
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