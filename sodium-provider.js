export const createSodiumProvider = sodiumLib => {
    let ready = false;

    return async () => {
        if (!ready) {
            console.log('Preparing sodium');

            await sodiumLib.ready;

            console.log('sodium ready');

            ready = true;
        }

        return sodiumLib;
    };
}