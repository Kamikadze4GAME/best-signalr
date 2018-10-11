'use strict';


const debug       = require('debug')('Signalr:transport');
const rp          = require('request-promise');
const helpers     = require('./helpers');
// const URL         = require('url');
// const querystring = require('querystring');

const START_ABORT_TEXT = '__Start Aborted__';


class Transport {
  constructor(connection) {
    this.connection = connection;
  }

  request(conn, options) {
    return rp(options);
  }



  pingServer() {
    let connection = this.connection;
    let url;

    return Promise.resolve()
      .then(_ => {
        if(connection.transport) {
          url = connection.url + '/ping';

          url = helpers.addQs(url, connection.qs);

          return this.request(url);
        }
        else {
          throw new Error('Connection is in an invalid state, there is no transport active.');
        }
      })
      .then(res => {
        try {
          res = helpers.parseResponse(res);
        } catch (e) {
          connection.stop();
          throw new Error('Failed to parse ping server response, stopping the connection.');
        }

        // res must be `{ "Response": "pong" }`
        if(res.Response !== 'pong') {
          throw new Error(`Invalid ping response when pinging server: '${res}'.`)
        }

        // All good
        // return;
      })
      .catch(err => {
        if(err.statusCode === 401 || err.statusCode === 403) {
          connection.stop();

          throw new Error(`Failed to ping server.  Server responded with status code ${err.statusCode}, stopping the connection.`);
        }
        else {
          throw new Error('Failed to ping server.');
        }
      });
  }

  prepareQueryString(url) {
    let connection = this.connection;
    let extraQs = {
      clientProtocol: connection.clientProtocol
    };

    if(connection.token) {
      extraQs.connectionToken = encodeURIComponent(connection.token);
    }

    // TODO: rename data or connectionData
    if(connection.data) {
      extraQs.connectionData = encodeURIComponent(connection.data);
    }

    // Add the user-specified query string params if any
    url = helpers.addQs(url, connection.qs);

    url = helpers.addQs(url, extraQs);

    return url;
  }

  // TODO: refact this
  getUrl(connection, transport, reconnecting, poll, ajaxPost) {
    let connection = this.connection;
    let baseUrl    = transport === 'webSockets' ? '' : connection.baseUrl;
    let url        = baseUrl + connection.appRelativeUrl;
    let qs         = {transport: transport};

    if(!ajaxPost && connection.groupsToken) {
      qs.groupsToken = encodeURIComponent(connection.groupsToken);
    }

    if(!reconnecting) {
      url += '/connect';
    } else {
      if(poll) {
        // longPolling transport specific
        url += '/poll';
      } else {
        url += '/reconnect';
      }

      if(!ajaxPost && connection.messageId) {
        qs.messageId = encodeURIComponent(connection.messageId);
      }
    }

    if(!ajaxPost) {
      qs.tid = Math.floor(Math.random() * 11);
    }

    url = helpers.addQs(url, qs);

    url = this.prepareQueryString(url);

    return url;
  }

  maximizePersistentResponse(data) {
    return {
      `MessageId      : data.C,
      Messages       : data.M,
      Initialized    : typeof (data.S) !== 'undefined' ? true : false,
      ShouldReconnect: typeof (data.T) !== 'undefined' ? true : false,
      LongPollDelay  : data.L,
      GroupsToken    : data.G`
    };
  }

  updateGroups(groupsToken) {
    if(groupsToken) {
      this.connection;.groupsToken = groupsToken;
    }
  }

  // TODO: refact
  getAjaxUrl(path) {
    let connection = this.connection;
    let url = connection.url + path;

    if(connection.transport) {
      url = helpers.addQs(url, {transport:connection.transport.name});
    }

    return this.prepareQueryString(connection, url);
  }

  ajaxSend(data) {
    let connection = this.connection;
    let payload = helpers.stringifySend(data);
    let url = this.getAjaxUrl('/send');


    return this.request()
    .then(res => {

    })
    .catch(err => {
      console.log('Test `err` must be like `abort` or `parsererror`');

      if(err === 'abort' || err === 'parsererror') {
        // The parsererror happens for sends that don't return any data, and hence
        // don't write the jsonp callback to the response. This is harder to fix on the server
        // so just hack around it on the client for now.
        return;
      }
    });

    return Promise.resolve()
      .then(_ => {
        return this.request({

        })
      })
      .catch(err => {

      })


    var payload = transportLogic.stringifySend(connection, data),
        url = getAjaxUrl(connection, "/send"),
        xhr,
        onFail = function (error, connection) {
            $(connection).triggerHandler(events.onError, [signalR._.transportError(signalR.resources.sendFailed, connection.transport, error, xhr), data]);
        };


    xhr = transportLogic.ajax(connection, {
        url: url,
        type: connection.ajaxDataType === "jsonp" ? "GET" : "POST",
        contentType: signalR._.defaultContentType,
        data: {
            data: payload
        },
        success: function (result) {
            var res;

            if (result) {
                try {
                    res = connection._parseResponse(result);
                }
                catch (error) {
                    onFail(error, connection);
                    connection.stop();
                    return;
                }

                transportLogic.triggerReceived(connection, res);
            }
        },
        error: function (error, textStatus) {
            if (textStatus === "abort" || textStatus === "parsererror") {
                // The parsererror happens for sends that don't return any data, and hence
                // don't write the jsonp callback to the response. This is harder to fix on the server
                // so just hack around it on the client for now.
                return;
            }

            onFail(error, connection);
        }
    });

    return xhr;
  }


  // TODO: not here ????
  checkIfAlive(connection) {
      var keepAliveData = connection._.keepAliveData,
          timeElapsed;

      // Only check if we're connected
      if (connection.state === signalR.connectionState.connected) {
          timeElapsed = new Date().getTime() - connection._.lastMessageAt;

          // Check if the keep alive has completely timed out
          if (timeElapsed >= keepAliveData.timeout) {
              connection.log("Keep alive timed out.  Notifying transport that connection has been lost.");

              // Notify transport that the connection has been lost
              connection.transport.lostConnection(connection);
          } else if (timeElapsed >= keepAliveData.timeoutWarning) {
              // This is to assure that the user only gets a single warning
              if (!keepAliveData.userNotified) {
                  connection.log("Keep alive has been missed, connection may be dead/slow.");
                  $(connection).triggerHandler(events.onConnectionSlow);
                  keepAliveData.userNotified = true;
              }
          } else {
              keepAliveData.userNotified = false;
          }
      }
  }

  // checkIsAlive() {
  //   let keepAliveData = this._.keepAliveData;
  //   let timeElapsed;
  //
  //   if(this.state === STATES.CONNECTED) {
  //     timeElapsed = new Date().getTime() - this._.lastMessageAt;
  //
  //     // Check if the keep alive has completely timed out
  //     if (timeElapsed >= keepAliveData.timeout) {
  //       debug('Keep alive timed out. Notifying transport that connection has been lost.');
  //
  //       // Notify transport that the connection has been lost
  //       console.log('TODO: this.transport.lostConnection(connection);');
  //       // this.transport.lostConnection(connection);
  //     }
  //     else if(timeElapsed >= keepAliveData.timeoutWarning) {
  //       // This is to assure that the user only gets a single warning
  //       if (!keepAliveData.userNotified) {
  //           debug("Keep alive has been missed, connection may be dead/slow.");
  //
  //           this.emit('slow');
  //           keepAliveData.userNotified = true;
  //       }
  //     }
  //     else {
  //       keepAliveData.userNotified = false;
  //     }
  //     // TODO:
  //   } else {
  //     return false
  //   }
  // }

}

let conn = {
  url:'https://socket.bittrex.com/signalr',
  transport:true
};

let a = new Transport(conn);

a.pingServer()
.then(res => {
  console.log(res);
})
