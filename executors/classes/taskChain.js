import {Task} from './task.js';
import {string} from '@stgroves/js-utilities';

export class TaskChain {
    #chain;
    #stopChain;

    constructor() {
        this.#chain = [];
    }

    #findByLabel(label) {
        const idx = this.#chain.findIndex((x) => x.getName() === label);

        if (idx === -1) throw new Error(`${label} cannot be found!`);

        return idx;
    }

    #validateTask(task) {
        if (!task instanceof Task)
            throw new Error(`task is not an instance of Task!`);
    }

    #validateLabel(label) {
        if (string.isEmptyOrNull(label)) throw new Error("label cannot be empty!");

        if (/\s/.test(label))
            throw new Error("label must not contain any whitespaces!");
    }

    getTask(label) {
        if (string.isEmptyOrNull(label)) throw new Error("Task must have a label!");

        if (/\s/.test(label))
            throw new Error("label must not contain any whitespaces!");

        return this.#chain[this.#findByLabel(label)];
    }

    breakChain(value = true) {
        this.#stopChain = value;
    }

    getInputTemplate() {
        return this.#chain.reduce(
            (template, task) => ({ ...template, ...task.getInputs() }),
            {}
        );
    }

    addTask(task) {
        this.#validateTask(task);

        this.#chain.push(task);
        task.setChain(this);
    }

    removeTask(task) {
        this.#validateTask(task);

        const idx = this.#chain.indexOf(task);

        if (idx === -1) throw new Error(`${task.getName()} cannot be found!`);

        this.#chain.splice(idx, 1);
        task.setChain(null);
    }

    insertBeforeTask(task, label) {
        this.#validateTask(task);
        this.#validateLabel(label);

        this.#chain.splice(this.#findByLabel(label), 0, task);
        task.setChain(this);
    }

    insertAfterTask(task, label) {
        this.#validateTask(task);
        this.#validateLabel(label);

        this.#chain.splice(this.#findByLabel(label) + 1, 0, task);
        task.setChain(this);
    }

    async run(inputs) {
        const context = { inputs, steps: {} };
        this.#stopChain = false;

        for (const task of this.#chain) {
            const [_, result] = await task.run(context);

            context.steps[task.getName()] = result;

            if (this.#stopChain)
                return;
        }
    }
}