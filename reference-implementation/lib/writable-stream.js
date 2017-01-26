'use strict';
const assert = require('assert');
const { InvokeOrNoop, PromiseInvokeOrNoop, ValidateAndNormalizeQueuingStrategy, typeIsObject } =
  require('./helpers.js');
const { rethrowAssertionErrorRejection } = require('./utils.js');
const { DequeueValue, EnqueueValueWithSize, GetTotalQueueSize, PeekQueueValue } = require('./queue-with-sizes.js');

class WritableStream {
  constructor(underlyingSink = {}, { size, highWaterMark = 1 } = {}) {
    this._state = 'writable';
    this._storedError = undefined;

    this._writer = undefined;

    // Initialize to undefined first because the constructor of the controller checks this
    // variable to validate the caller.
    this._writableStreamController = undefined;

    // This queue is placed here instead of the writer class in order to allow for passing a writer to the next data
    // producer without waiting for the queued writes to finish.
    this._writeRequests = [];

    // Write requests are removed from _writeRequests when write() is called on the underlying sink. This prevents
    // them from being erroneously rejected on error. If a write() call is inflight, the request is stored here.
    this._inflightWriteRequest = undefined;

    // The promise that was returned from writer.close(). Stored here because it may be fulfilled after the writer
    // has been detached.
    this._closeRequest = undefined;

    // Close request is removed from _closeRequest when close() is called on the underlying sink. This prevents it
    // from being erroneously rejected on error. If a close() call is inflight, the request is stored here.
    this._inflightCloseRequest = undefined;

    // The promise that was returned from writer.abort(). This may also be fulfilled after the writer has detached.
    this._pendingAbortRequest = undefined;

    // The backpressure signal set by the controller.
    this._backpressure = undefined;

    const type = underlyingSink.type;

    if (type !== undefined) {
      throw new RangeError('Invalid type is specified');
    }

    this._writableStreamController = new WritableStreamDefaultController(this, underlyingSink, size, highWaterMark);
    WritableStreamDefaultControllerStart(this._writableStreamController);
  }

  get locked() {
    if (IsWritableStream(this) === false) {
      throw streamBrandCheckException('locked');
    }

    return IsWritableStreamLocked(this);
  }

  abort(reason) {
    if (IsWritableStream(this) === false) {
      return Promise.reject(streamBrandCheckException('abort'));
    }

    if (IsWritableStreamLocked(this) === true) {
      return Promise.reject(new TypeError('Cannot abort a stream that already has a writer'));
    }

    return WritableStreamAbort(this, reason);
  }

  getWriter() {
    if (IsWritableStream(this) === false) {
      throw streamBrandCheckException('getWriter');
    }

    return AcquireWritableStreamDefaultWriter(this);
  }
}

module.exports = {
  AcquireWritableStreamDefaultWriter,
  IsWritableStream,
  IsWritableStreamLocked,
  WritableStream,
  WritableStreamAbort,
  WritableStreamDefaultControllerError,
  WritableStreamDefaultWriterCloseWithErrorPropagation,
  WritableStreamDefaultWriterRelease,
  WritableStreamDefaultWriterWrite
};

// Abstract operations for the WritableStream.

function AcquireWritableStreamDefaultWriter(stream) {
  return new WritableStreamDefaultWriter(stream);
}

function IsWritableStream(x) {
  if (!typeIsObject(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_writableStreamController')) {
    return false;
  }

  return true;
}

function IsWritableStreamLocked(stream) {
  assert(IsWritableStream(stream) === true, 'IsWritableStreamLocked should only be used on known writable streams');

  if (stream._writer === undefined) {
    return false;
  }

  return true;
}

function WritableStreamIsReadyForWrites(stream) {
  if (stream._state === 'writable' && stream._pendingAbortRequest === undefined && stream._closeRequest === undefined &&
      stream._backpressure === true) {
    return true;
  }

  return false;
}

function WritableStreamAbort(stream, reason) {
  const state = stream._state;
  if (state === 'closed') {
    return Promise.resolve(undefined);
  }
  if (state === 'errored') {
    return Promise.reject(stream._storedError);
  }
  const error = new TypeError('Aborted');
  if (stream._pendingAbortRequest !== undefined) {
    return Promise.reject(error);
  }

  assert(state === 'writable', 'state must be writable or closing');

  const controller = stream._writableStreamController;
  assert(controller !== undefined, 'controller must not be undefined');

  WritableStreamDefaultWriterEnsureReadyPromiseRejectedWith(stream, error);

  if (WritableStreamHasOperationMarkedInflight(stream) === false) {
    WritableStreamFinishAbort(stream);
    return WritableStreamDefaultControllerAbort(controller, reason);
  }

  const promise = new Promise((resolve, reject) => {
    stream._pendingAbortRequest = {
      _resolve: resolve,
      _reject: reject,
      _reason: reason
    };
  });

  return promise;
}

function WritableStreamFinishAbort(stream) {
  stream._state = 'errored';
  stream._storedError = new TypeError('Aborted');

  WritableStreamRejectPromisesInReactionToError(stream);
}

// WritableStream API exposed for controllers.

function WritableStreamAddWriteRequest(stream) {
  assert(IsWritableStreamLocked(stream) === true);
  assert(stream._state === 'writable');

  const promise = new Promise((resolve, reject) => {
    const writeRequest = {
      _resolve: resolve,
      _reject: reject
    };

    stream._writeRequests.push(writeRequest);
  });

  return promise;
}

function WritableStreamFinishInflightWrite(stream) {
  assert(stream._inflightWriteRequest !== undefined);
  stream._inflightWriteRequest._resolve(undefined);
  stream._inflightWriteRequest = undefined;

  const state = stream._state;

  if (state === 'errored') {
    WritableStreamRejectPendingAbortRequest(stream);
    WritableStreamRejectPromisesInReactionToError(stream);

    return;
  }

  if (stream._pendingAbortRequest === undefined) {
    return;
  }

  WritableStreamFinishAbort(stream, state);

  const abortRequest = stream._pendingAbortRequest;
  stream._pendingAbortRequest = undefined;
  const promise = WritableStreamDefaultControllerAbort(stream._writableStreamController, abortRequest._reason);
  promise.then(
    abortRequest._resolve,
    abortRequest._reject
  );
}

function WritableStreamFinishInflightWriteWithError(stream, reason) {
  assert(stream._inflightWriteRequest !== undefined);
  stream._inflightWriteRequest._reject(reason);
  stream._inflightWriteRequest = undefined;

  const state = stream._state;

  let wasAborted = false;
  if (stream._pendingAbortRequest !== undefined) {
    wasAborted = true;
  }

  const isReadyForWrites = WritableStreamIsReadyForWrites(stream);

  if (state === 'errored') {
    WritableStreamRejectPendingAbortRequest(stream);
  } else {
    assert(state === 'writable');

    stream._state = 'errored';
    stream._storedError = reason;

    if (wasAborted === false) {
      WritableStreamDefaultWriterEnsureReadyPromiseRejectedWith(stream, reason, isReadyForWrites);
    }

    WritableStreamRejectPendingAbortRequest(stream);
  }

  WritableStreamRejectPromisesInReactionToError(stream);
}

function WritableStreamFinishInflightClose(stream) {
  assert(stream._inflightCloseRequest !== undefined);
  stream._inflightCloseRequest._resolve(undefined);
  stream._inflightCloseRequest = undefined;

  const state = stream._state;

  let wasAborted = false;
  if (stream._pendingAbortRequest !== undefined) {
    wasAborted = true;
  }

  if (state === 'errored') {
    WritableStreamRejectPendingAbortRequest(stream);
    WritableStreamRejectClosedPromiseIfAny(stream);

    return;
  }

  assert(state === 'writable');

  if (wasAborted === false) {
    const writer = stream._writer;
    if (writer !== undefined) {
      defaultWriterClosedPromiseResolve(writer);
    }
    stream._state = 'closed';
    return;
  }

  stream._pendingAbortRequest._resolve();
  stream._pendingAbortRequest = undefined;

  stream._state = 'errored';
  stream._storedError = new TypeError('Abort requested but closed successfully');

  // No readyPromise resetting to rejected?

  WritableStreamRejectClosedPromiseIfAny(stream);
}

function WritableStreamFinishInflightCloseWithError(stream, reason) {
  assert(stream._inflightCloseRequest !== undefined);
  stream._inflightCloseRequest._reject(reason);
  stream._inflightCloseRequest = undefined;

  const state = stream._state;

  let wasAborted = false;
  if (stream._pendingAbortRequest !== undefined) {
    wasAborted = true;
  }

  if (state === 'errored') {
    WritableStreamRejectPendingAbortRequest(stream);
  } else {
    assert(state === 'writable');

    stream._state = 'errored';
    stream._storedError = reason;

    if (wasAborted === false) {
      WritableStreamDefaultWriterEnsureReadyPromiseRejectedWith(stream, reason, false);
    }

    WritableStreamRejectPendingAbortRequest(stream);
  }

  WritableStreamRejectClosedPromiseIfAny(stream);
}

function WritableStreamHasOperationMarkedInflight(stream) {
  if (stream._inflightWriteRequest === undefined && stream._inflightCloseRequest === undefined) {
    return false;
  }

  return true;
}

function WritableStreamMarkCloseRequestInflight(stream) {
  assert(stream._inflightCloseRequest === undefined);
  assert(stream._closeRequest !== undefined);
  stream._inflightCloseRequest = stream._closeRequest;
  stream._closeRequest = undefined;
}

function WritableStreamMarkFirstWriteRequestInflight(stream) {
  assert(stream._inflightWriteRequest === undefined, 'there must be no pending write request');
  assert(stream._writeRequests.length !== 0, 'writeRequests must not be empty');
  stream._inflightWriteRequest = stream._writeRequests.shift();
}

function WritableStreamRejectClosedPromiseIfAny(stream) {
  const writer = stream._writer;
  if (writer !== undefined) {
    defaultWriterClosedPromiseReject(writer, stream._storedError);
    writer._closedPromise.catch(() => {});
  }
}

function WritableStreamRejectPendingAbortRequest(stream) {
  if (stream._pendingAbortRequest !== undefined) {
    stream._pendingAbortRequest._reject(stream._storedError);
    stream._pendingAbortRequest = undefined;
  }
}

function WritableStreamRejectPromisesInReactionToError(stream) {
  assert(stream._state === 'errored');

  const storedError = stream._storedError;

  for (const writeRequest of stream._writeRequests) {
    writeRequest._reject(storedError);
  }
  stream._writeRequests = [];

  if (stream._closeRequest !== undefined) {
    assert(stream._inflightCloseRequest === undefined);

    stream._closeRequest._reject(storedError);
    stream._closeRequest = undefined;
  }

  WritableStreamRejectClosedPromiseIfAny(stream);
}

function WritableStreamUpdateBackpressure(stream, backpressure) {
  assert(stream._state === 'writable');
  assert(stream._closeRequest === undefined);

  const writer = stream._writer;
  if (writer !== undefined && backpressure !== stream._backpressure) {
    if (backpressure === true) {
      defaultWriterReadyPromiseReset(writer);
    } else {
      assert(backpressure === false);

      defaultWriterReadyPromiseResolve(writer);
    }
  }

  stream._backpressure = backpressure;
}

class WritableStreamDefaultWriter {
  constructor(stream) {
    if (IsWritableStream(stream) === false) {
      throw new TypeError('WritableStreamDefaultWriter can only be constructed with a WritableStream instance');
    }
    if (IsWritableStreamLocked(stream) === true) {
      throw new TypeError('This stream has already been locked for exclusive writing by another writer');
    }

    this._ownerWritableStream = stream;
    stream._writer = this;

    const state = stream._state;

    if (state === 'writable') {
      if (stream._pendingAbortRequest !== undefined) {
        // TODO: Test this
        defaultWriterReadyPromiseInitializeAsRejected(this, stream._storedError);
      } else if (stream._closeRequest === undefined && stream._backpressure === true) {
        defaultWriterReadyPromiseInitialize(this);
      } else {
        defaultWriterReadyPromiseInitializeAsResolved(this, undefined);
      }

      defaultWriterClosedPromiseInitialize(this);
    } else if (state === 'closed') {
      defaultWriterReadyPromiseInitializeAsResolved(this, undefined);
      defaultWriterClosedPromiseInitializeAsResolved(this);
    } else {
      assert(state === 'errored', 'state must be errored');

      // TODO: Test this
      const storedError = stream._storedError;
      // defaultWriterReadyPromiseInitializeAsResolved(this, undefined);
      defaultWriterReadyPromiseInitializeAsRejected(this, storedError);
      defaultWriterClosedPromiseInitializeAsRejected(this, storedError);
      this._closedPromise.catch(() => {});
    }
  }

  get closed() {
    if (IsWritableStreamDefaultWriter(this) === false) {
      return Promise.reject(defaultWriterBrandCheckException('closed'));
    }

    return this._closedPromise;
  }

  get desiredSize() {
    if (IsWritableStreamDefaultWriter(this) === false) {
      throw defaultWriterBrandCheckException('desiredSize');
    }

    if (this._ownerWritableStream === undefined) {
      throw defaultWriterLockException('desiredSize');
    }

    return WritableStreamDefaultWriterGetDesiredSize(this);
  }

  get ready() {
    if (IsWritableStreamDefaultWriter(this) === false) {
      return Promise.reject(defaultWriterBrandCheckException('ready'));
    }

    return this._readyPromise;
  }

  abort(reason) {
    if (IsWritableStreamDefaultWriter(this) === false) {
      return Promise.reject(defaultWriterBrandCheckException('abort'));
    }

    if (this._ownerWritableStream === undefined) {
      return Promise.reject(defaultWriterLockException('abort'));
    }

    return WritableStreamDefaultWriterAbort(this, reason);
  }

  close() {
    if (IsWritableStreamDefaultWriter(this) === false) {
      return Promise.reject(defaultWriterBrandCheckException('close'));
    }

    const stream = this._ownerWritableStream;

    if (stream === undefined) {
      return Promise.reject(defaultWriterLockException('close'));
    }

    if (stream._closeRequest !== undefined) {
      return Promise.reject(new TypeError('cannot close an already-closing stream'));
    }

    return WritableStreamDefaultWriterClose(this);
  }

  releaseLock() {
    if (IsWritableStreamDefaultWriter(this) === false) {
      throw defaultWriterBrandCheckException('releaseLock');
    }

    const stream = this._ownerWritableStream;

    if (stream === undefined) {
      return;
    }

    assert(stream._writer !== undefined);

    WritableStreamDefaultWriterRelease(this);
  }

  write(chunk) {
    if (IsWritableStreamDefaultWriter(this) === false) {
      return Promise.reject(defaultWriterBrandCheckException('write'));
    }

    const stream = this._ownerWritableStream;

    if (stream === undefined) {
      return Promise.reject(defaultWriterLockException('write to'));
    }

    if (stream._closeRequest !== undefined) {
      return Promise.reject(new TypeError('Cannot write to an already-closed stream'));
    }

    return WritableStreamDefaultWriterWrite(this, chunk);
  }
}

// Abstract operations for the WritableStreamDefaultWriter.

function IsWritableStreamDefaultWriter(x) {
  if (!typeIsObject(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_ownerWritableStream')) {
    return false;
  }

  return true;
}

function WritableStreamDefaultWriterEnsureReadyPromiseRejectedWith(stream, error, isPending) {
  const writer = stream._writer;
  if (writer === undefined) {
    return;
  }

  if (isPending === undefined) {
    isPending = WritableStreamIsReadyForWrites(stream);
  }

  if (isPending === true) {
    defaultWriterReadyPromiseReject(writer, error);
  } else {
    defaultWriterReadyPromiseResetToRejected(writer, error);
  }
  writer._readyPromise.catch(() => {});
}

// A client of WritableStreamDefaultWriter may use these functions directly to bypass state check.

function WritableStreamDefaultWriterAbort(writer, reason) {
  const stream = writer._ownerWritableStream;

  assert(stream !== undefined);

  return WritableStreamAbort(stream, reason);
}

function WritableStreamDefaultWriterClose(writer) {
  const stream = writer._ownerWritableStream;

  assert(stream !== undefined);

  const state = stream._state;
  if (state === 'closed' || state === 'errored') {
    return Promise.reject(new TypeError(
      `The stream (in ${state} state) is not in the writable state and cannot be closed`));
  }
  if (stream._pendingAbortRequest !== undefined) {
    return Promise.reject(new TypeError('Aborted'));
  }

  assert(state === 'writable');
  assert(stream._closeRequest === undefined);

  const promise = new Promise((resolve, reject) => {
    const closeRequest = {
      _resolve: resolve,
      _reject: reject
    };

    stream._closeRequest = closeRequest;
  });

  if (stream._backpressure === true) {
    defaultWriterReadyPromiseResolve(writer);
  }

  WritableStreamDefaultControllerClose(stream._writableStreamController);

  return promise;
}


function WritableStreamDefaultWriterCloseWithErrorPropagation(writer) {
  const stream = writer._ownerWritableStream;

  assert(stream !== undefined);

  const state = stream._state;
  if ((state === 'writable' && stream._closeRequest !== undefined) || state === 'closed') {
    return Promise.resolve();
  }

  if (state === 'errored') {
    return Promise.reject(stream._storedError);
  }

  assert(state === 'writable');

  return WritableStreamDefaultWriterClose(writer);
}

function WritableStreamDefaultWriterGetDesiredSize(writer) {
  const stream = writer._ownerWritableStream;
  const state = stream._state;

  if (state === 'errored' || stream._pendingAbortRequest !== undefined) {
    return null;
  }

  if (state === 'closed') {
    return 0;
  }

  return WritableStreamDefaultControllerGetDesiredSize(stream._writableStreamController);
}

function WritableStreamDefaultWriterRelease(writer) {
  const stream = writer._ownerWritableStream;
  assert(stream !== undefined);
  assert(stream._writer === writer);

  const releasedError = new TypeError(
    'Writer was released and can no longer be used to monitor the stream\'s closedness');
  const state = stream._state;

  WritableStreamDefaultWriterEnsureReadyPromiseRejectedWith(stream, releasedError);

  if (state === 'writable' || WritableStreamHasOperationMarkedInflight(stream) === true) {
    defaultWriterClosedPromiseReject(writer, releasedError);
  } else {
    defaultWriterClosedPromiseResetToRejected(writer, releasedError);
  }
  writer._closedPromise.catch(() => {});

  stream._writer = undefined;
  writer._ownerWritableStream = undefined;
}

function WritableStreamDefaultWriterWrite(writer, chunk) {
  const stream = writer._ownerWritableStream;

  assert(stream !== undefined);
  assert(stream._closeRequest === undefined);

  const state = stream._state;
  if (state === 'closed' || state === 'errored') {
    return Promise.reject(new TypeError(
      `The stream (in ${state} state) is not in the writable state and cannot be written to`));
  }
  if (stream._pendingAbortRequest !== undefined) {
    return Promise.reject(new TypeError('Aborted'));
  }

  assert(state === 'writable');

  const promise = WritableStreamAddWriteRequest(stream);

  WritableStreamDefaultControllerWrite(stream._writableStreamController, chunk);

  return promise;
}

class WritableStreamDefaultController {
  constructor(stream, underlyingSink, size, highWaterMark) {
    if (IsWritableStream(stream) === false) {
      throw new TypeError('WritableStreamDefaultController can only be constructed with a WritableStream instance');
    }

    if (stream._writableStreamController !== undefined) {
      throw new TypeError(
        'WritableStreamDefaultController instances can only be created by the WritableStream constructor');
    }

    this._controlledWritableStream = stream;

    this._underlyingSink = underlyingSink;

    this._queue = [];
    this._started = false;

    const normalizedStrategy = ValidateAndNormalizeQueuingStrategy(size, highWaterMark);
    this._strategySize = normalizedStrategy.size;
    this._strategyHWM = normalizedStrategy.highWaterMark;

    const backpressure = WritableStreamDefaultControllerGetBackpressure(this);
    WritableStreamUpdateBackpressure(stream, backpressure);
  }

  error(e) {
    if (IsWritableStreamDefaultController(this) === false) {
      throw new TypeError(
        'WritableStreamDefaultController.prototype.error can only be used on a WritableStreamDefaultController');
    }

    const state = this._controlledWritableStream._state;
    if (state === 'closed' || state === 'errored') {
      throw new TypeError(`The stream is ${state} and so cannot be errored`);
    }

    WritableStreamDefaultControllerError(this, e);
  }
}

// Abstract operations implementing interface required by the WritableStream.

function WritableStreamDefaultControllerAbort(controller, reason) {
  controller._queue = [];

  const sinkAbortPromise = PromiseInvokeOrNoop(controller._underlyingSink, 'abort', [reason]);
  return sinkAbortPromise.then(() => undefined);
}

function WritableStreamDefaultControllerClose(controller) {
  EnqueueValueWithSize(controller._queue, 'close', 0);
  WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
}

function WritableStreamDefaultControllerGetDesiredSize(controller) {
  const queueSize = GetTotalQueueSize(controller._queue);
  return controller._strategyHWM - queueSize;
}

function WritableStreamDefaultControllerWrite(controller, chunk) {
  let chunkSize = 1;

  if (controller._strategySize !== undefined) {
    const strategySize = controller._strategySize;
    try {
      chunkSize = strategySize(chunk);
    } catch (chunkSizeE) {
      // TODO: Should we notify the sink of this error?
      WritableStreamDefaultControllerErrorIfNeeded(controller, chunkSizeE);
      return;
    }
  }

  const writeRecord = { chunk };

  try {
    EnqueueValueWithSize(controller._queue, writeRecord, chunkSize);
  } catch (enqueueE) {
    WritableStreamDefaultControllerErrorIfNeeded(controller, enqueueE);
    return;
  }

  const stream = controller._controlledWritableStream;
  if (stream._state === 'writable' && stream._closeRequest === undefined) {
    const backpressure = WritableStreamDefaultControllerGetBackpressure(controller);
    WritableStreamUpdateBackpressure(stream, backpressure);
  }

  WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
}

// Abstract operations for the WritableStreamDefaultController.

function IsWritableStreamDefaultController(x) {
  if (!typeIsObject(x)) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(x, '_underlyingSink')) {
    return false;
  }

  return true;
}

function WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller) {
  const stream = controller._controlledWritableStream;
  const state = stream._state;

  if (state === 'closed' || state === 'errored') {
    return;
  }

  if (controller._started === false) {
    return;
  }

  if (stream._inflightWriteRequest !== undefined) {
    return;
  }

  if (controller._queue.length === 0) {
    return;
  }

  const writeRecord = PeekQueueValue(controller._queue);
  if (writeRecord === 'close') {
    WritableStreamDefaultControllerProcessClose(controller);
  } else {
    WritableStreamDefaultControllerProcessWrite(controller, writeRecord.chunk);
  }
}

function WritableStreamDefaultControllerErrorIfNeeded(controller, e) {
  if (controller._controlledWritableStream._state === 'writable') {
    WritableStreamDefaultControllerError(controller, e);
  }
}

function WritableStreamDefaultControllerProcessClose(controller) {
  const stream = controller._controlledWritableStream;

  WritableStreamMarkCloseRequestInflight(stream);

  DequeueValue(controller._queue);
  assert(controller._queue.length === 0, 'queue must be empty once the final write record is dequeued');

  const sinkClosePromise = PromiseInvokeOrNoop(controller._underlyingSink, 'close', [controller]);
  sinkClosePromise.then(
    () => {
      WritableStreamFinishInflightClose(stream);
    },
    reason => {
      WritableStreamFinishInflightCloseWithError(stream, reason);
    }
  )
  .catch(rethrowAssertionErrorRejection);
}

function WritableStreamDefaultControllerProcessWrite(controller, chunk) {
  const stream = controller._controlledWritableStream;

  WritableStreamMarkFirstWriteRequestInflight(stream);

  const sinkWritePromise = PromiseInvokeOrNoop(controller._underlyingSink, 'write', [chunk, controller]);
  sinkWritePromise.then(
    () => {
      WritableStreamFinishInflightWrite(stream);

      const state = stream._state;
      if (state === 'errored') {
        return;
      }

      assert(state === 'writable');

      DequeueValue(controller._queue);

      if (stream._closeRequest === undefined) {
        const backpressure = WritableStreamDefaultControllerGetBackpressure(controller);
        WritableStreamUpdateBackpressure(stream, backpressure);
      }

      WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
    },
    reason => {
      const wasErrored = stream._state === 'errored';

      WritableStreamFinishInflightWriteWithError(stream, reason);

      assert(stream._state === 'errored');
      if (wasErrored === false) {
        controller._queue = [];
      }
    }
  )
  .catch(rethrowAssertionErrorRejection);
}

function WritableStreamDefaultControllerStart(controller) {
  const startResult = InvokeOrNoop(controller._underlyingSink, 'start', [controller]);
  Promise.resolve(startResult).then(
    () => {
      controller._started = true;
      // TODO: Test this.
      WritableStreamDefaultControllerAdvanceQueueIfNeeded(controller);
    },
    r => {
      WritableStreamDefaultControllerErrorIfNeeded(controller, r);
    }
  )
  .catch(rethrowAssertionErrorRejection);
}

function WritableStreamDefaultControllerGetBackpressure(controller) {
  const desiredSize = WritableStreamDefaultControllerGetDesiredSize(controller);
  return desiredSize <= 0;
}

// A client of WritableStreamDefaultController may use these functions directly to bypass state check.

function WritableStreamDefaultControllerError(controller, e) {
  const stream = controller._controlledWritableStream;

  assert(stream._state === 'writable');

  const isReadyForWrites = WritableStreamIsReadyForWrites(stream);

  stream._state = 'errored';
  stream._storedError = e;

  if (stream._pendingAbortRequest === undefined) {
    WritableStreamDefaultWriterEnsureReadyPromiseRejectedWith(stream, e, isReadyForWrites);
  }

  controller._queue = [];

  if (WritableStreamHasOperationMarkedInflight(stream) === false) {
    WritableStreamRejectPromisesInReactionToError(stream);
  }
}

// Helper functions for the WritableStream.

function streamBrandCheckException(name) {
  return new TypeError(`WritableStream.prototype.${name} can only be used on a WritableStream`);
}

// Helper functions for the WritableStreamDefaultWriter.

function defaultWriterBrandCheckException(name) {
  return new TypeError(
    `WritableStreamDefaultWriter.prototype.${name} can only be used on a WritableStreamDefaultWriter`);
}

function defaultWriterLockException(name) {
  return new TypeError('Cannot ' + name + ' a stream using a released writer');
}

function defaultWriterClosedPromiseInitialize(writer) {
  writer._closedPromise = new Promise((resolve, reject) => {
    writer._closedPromise_resolve = resolve;
    writer._closedPromise_reject = reject;
  });
}

function defaultWriterClosedPromiseInitializeAsRejected(writer, reason) {
  writer._closedPromise = Promise.reject(reason);
  writer._closedPromise_resolve = undefined;
  writer._closedPromise_reject = undefined;
}

function defaultWriterClosedPromiseInitializeAsResolved(writer) {
  writer._closedPromise = Promise.resolve(undefined);
  writer._closedPromise_resolve = undefined;
  writer._closedPromise_reject = undefined;
}

function defaultWriterClosedPromiseReject(writer, reason) {
  assert(writer._closedPromise_resolve !== undefined);
  assert(writer._closedPromise_reject !== undefined);

  writer._closedPromise_reject(reason);
  writer._closedPromise_resolve = undefined;
  writer._closedPromise_reject = undefined;
}

function defaultWriterClosedPromiseResetToRejected(writer, reason) {
  assert(writer._closedPromise_resolve === undefined);
  assert(writer._closedPromise_reject === undefined);

  writer._closedPromise = Promise.reject(reason);
}

function defaultWriterClosedPromiseResolve(writer) {
  assert(writer._closedPromise_resolve !== undefined);
  assert(writer._closedPromise_reject !== undefined);

  writer._closedPromise_resolve(undefined);
  writer._closedPromise_resolve = undefined;
  writer._closedPromise_reject = undefined;
}

function defaultWriterReadyPromiseInitialize(writer) {
  writer._readyPromise = new Promise((resolve, reject) => {
    writer._readyPromise_resolve = resolve;
    writer._readyPromise_reject = reject;
  });
}

function defaultWriterReadyPromiseInitializeAsRejected(writer, reason) {
  writer._readyPromise = Promise.reject(reason);
  writer._readyPromise_resolve = undefined;
  writer._readyPromise_reject = undefined;
}

function defaultWriterReadyPromiseInitializeAsResolved(writer) {
  writer._readyPromise = Promise.resolve(undefined);
  writer._readyPromise_resolve = undefined;
  writer._readyPromise_reject = undefined;
}

function defaultWriterReadyPromiseReject(writer, reason) {
  assert(writer._readyPromise_resolve !== undefined);
  assert(writer._readyPromise_reject !== undefined);

  writer._readyPromise_reject(reason);
  writer._readyPromise_resolve = undefined;
  writer._readyPromise_reject = undefined;
}

function defaultWriterReadyPromiseReset(writer) {
  assert(writer._readyPromise_resolve === undefined);
  assert(writer._readyPromise_reject === undefined);

  writer._readyPromise = new Promise((resolve, reject) => {
    writer._readyPromise_resolve = resolve;
    writer._readyPromise_reject = reject;
  });
}

function defaultWriterReadyPromiseResetToRejected(writer, reason) {
  assert(writer._readyPromise_resolve === undefined);
  assert(writer._readyPromise_reject === undefined);

  writer._readyPromise = Promise.reject(reason);
}

function defaultWriterReadyPromiseResolve(writer) {
  assert(writer._readyPromise_resolve !== undefined);
  assert(writer._readyPromise_reject !== undefined);

  writer._readyPromise_resolve(undefined);
  writer._readyPromise_resolve = undefined;
  writer._readyPromise_reject = undefined;
}
