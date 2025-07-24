export const executeSafely = async (callback, ...args) => {
    try {
        const result = await callback(...args);
        return [true, result];
    } catch (error) {
        console.error(`Failed to execute function!`, {
            message: error.message,
            response: error.response?.data,
            stack: error.stack
        });

        return [false, error];
    }
};