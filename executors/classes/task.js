import {string, object} from '@stgroves/js-utilities';

export class Task extends EventTarget {
    #action;
    #label;
    #config;
    #chain;

    constructor(
        label,
        action,
        config = {}
    ) {
        super();

        this.#validateInputs(label, action, config);

        this.#label = label;
        this.#action = action;
        this.#config = config;

        this.#chain = null;
    }

    #validateInputs(label, action, config) {
        if (string.isEmptyOrNull(label)) throw new Error("Task must have a label!");

        if (/\s/.test(label))
            throw new Error("label must not contain any whitespaces!");

        if (typeof action !== "function")
            throw new Error("Task action must be a Function!");

        if (typeof config !== "object")
            throw new Error("config must be an Object!");

        const {
            inputs = [],
            retries = 3,
            interval = 2000,
            stopRetries = (error) => [error.status === 404, error]
        } = config;

        if (!Array.isArray(inputs)) throw new Error("inputs must be an array!");

        inputs.forEach((input) => {
            const { name, isTemplate = true } = input;

            if (string.isEmptyOrNull(name))
                throw new Error("inputs must have a name!");

            if (typeof isTemplate !== 'boolean')
                throw new Error('isTemplate must be a boolean!');
        });

        if (typeof retries !== "number") throw new Error("retries must be a number!");

        if (retries < 1) throw new Error("retries must be at least 1!");

        if (typeof interval !== "number")
            throw new Error("interval must be a number!");

        if (interval < 500) throw new Error("interval must be at least 500(ms)!");

        if (typeof stopRetries !== "function")
            throw new Error("stopRetries must be a Function!");
    }

    #dispatchEvent(event, context, stopChain = true) {
        const customEvent = new CustomEvent(event, { detail: { task: this, context: object.deepClone(context) } });

        customEvent.detail.breakChain = (value) => {
            if (value === stopChain)
                return;

            customEvent.stopPropagation();
            stopChain = value;
        };

        dispatchEvent(customEvent);

        if (stopChain)
            this.#chain.breakChain();
    }

    setChain(chain) {
        this.#chain = chain;
    }

    getName() {
        return this.#label;
    }

    getInputs() {
        const NEW_OBJECT = {};

        this.#config.inputs.forEach((input) => {
            const { name, defaultValue = undefined, isTemplate = true } = input;
            NEW_OBJECT[name] = isTemplate ? object.deepClone(defaultValue) : defaultValue;
        });

        return NEW_OBJECT;
    }

    async run(context) {
        const {
            retries = 3,
            interval = 2000,
            stopRetries = (error) => [error.status === 404, error]
        } = this.#config;

        let attempt = 1;

        while (attempt <= retries) {
            try {
                const result = await this.#action(context);

                this.#dispatchEvent('taskSuccess', { result }, false);

                return [true, result];
            } catch (e) {
                console.error(`Attempt ${attempt} failed:`, {
                    message: e.message,
                    response: e.response?.data,
                    stack: e.stack
                });

                const [shouldStop, error] = stopRetries(e);

                if (shouldStop) {
                    this.#dispatchEvent('taskError', { error });
                    return [false, error];
                }

                if (attempt >= retries) {
                    const error = new Error(`Request failed after ${retries} attempts`);

                    this.#dispatchEvent('taskError', { error });

                    return [false, error];
                }

                const delay = interval * 2 ** (attempt - 1);

                console.log(`Retrying in ${delay / 1000} seconds...`);
                await new Promise((res) => setTimeout(res, delay));
                attempt++;
            }
        }
    }
}