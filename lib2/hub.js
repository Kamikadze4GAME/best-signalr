'use strict';

const EventEmitter = require('eventemitter2');

class Hub extends EventEmitter {
  constructor(name, connection) {
    super({wildcard:true});
    
    this._name = name;
    this._connection = connection;
  }

  invoke(method, args = []) {
    return this._connection.invoke(this._name, method, args);
  }

}

module.exports = Hub;
