import {App} from 'octokit';

let cachedOctokit = null;

export const createAppOctokitProvider = (appID, pem, installationID) => {
    return async () => {
        if (cachedOctokit)
            return cachedOctokit;

        const app = new App({appId: appID, privateKey: pem});
        return app.getInstallationOctokit(installationID);
    }
};