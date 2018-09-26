const URL         = require('url');
const querystring = require('querystring');



module.exports = {
  parseResponse: (data) => {
    if(typeof data === 'string') {
      return JSON.parse(data);
    }

    // Not string or `undefined` or null or etc
    return data;
  },

  stringifySend(message) {
    if(typeof (message) === 'string' || typeof (message) === 'undefined' || message === null) {
      return message;
    }

    return JSON.stringify(message);
  },

  addQs: (url, qs = {}) => {
    url = new URL.URL(url);

    if(typeof qs === 'string') {
      qs = querystring.parse(qs);
    }
    else if(typeof qs === 'object') {
      Object.keys(qs).forEach(key => {
        url.searchParams.set(key, qs[key]);
      });
    }
    else {
      throw new Error('Query string property must be either a string or object.')
    }

    return URL.format(url);
  }
};
