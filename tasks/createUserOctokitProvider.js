import {Octokit} from 'octokit';

let cachedOctokit = null;

export const createUserOctokitProvider = (accessToken) => {
    return async () => {
        if (cachedOctokit)
            return cachedOctokit;

        return new Octokit({auth: accessToken});
    }
}