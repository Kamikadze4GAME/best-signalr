'use strict';

class HubError extends Error {
  constructor(message, data = null, stack = null) {
    super(message);
    this._data = data;
    Error.captureStackTrace(this, HubError);
    // this._stack = trace;
  }

  get data() {
    return this._data;
  }
  //
  // get trace() {
  //   return this._trace;
  // }
}

class ServerError extends Error {
  constructor(message, data = null, trace = null) {
    super(message);

    // Saving class name in the property of our custom error as a shortcut.
   this.name = this.constructor.name;

    // Error.captureStackTrace(this, ServerError);
    this._data = data;
    // this._trace = trace;
  }

  get data() {
    return this._data;
  }

  get stack() {
    return 'STACK';
  }
}

module.exports = {
  HubError,
  ServerError
};
