"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMatrixInterruptSignal = createMatrixInterruptSignal;
exports.withMatrixInterrupt = withMatrixInterrupt;
const types_js_1 = require("./types.js");
function createMatrixInterruptSignal(onInterrupt) {
    let rejectInterrupted = () => { };
    const interrupted = new Promise((_resolve, reject) => {
        rejectInterrupted = reject;
    });
    let active = true;
    const onSignal = (signal) => {
        if (!active) {
            return;
        }
        active = false;
        const error = new types_js_1.MatrixInterruptedError(signal);
        onInterrupt(error);
        rejectInterrupted(error);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    return {
        interrupted,
        dispose: () => {
            active = false;
            process.off('SIGINT', onSignal);
            process.off('SIGTERM', onSignal);
        },
    };
}
async function withMatrixInterrupt(operation, interrupted) {
    return Promise.race([operation, interrupted]);
}
