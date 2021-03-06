var fs = require('fs');

var Promise = require('promise');
var request = require('request');
var superagent = require('superagent');


function getAccessToken(authCode) {
    console.log('Getting access token from auth code');
    return new Promise(function(resolve, reject) {
        superagent.post('https://www.box.com/api/oauth2/token')
            .type('form')
            .send({grant_type: 'authorization_code'})
            .send({code: authCode})
            .send({client_id: process.env.CLIENT_ID})
            .send({client_secret: process.env.CLIENT_SECRET})
            .end(function(res) {
                console.log('Got response from access token');
                if (res.error) return reject(res.error);
                resolve(res.body.access_token, res.body.refresh_token, Date.now() + res.body.expires_in * 1000);
            });
    });
}
function getNewAccessToken(refreshToken) {
    console.log('Getting new access token from auth code');
    return new Promise(function(resolve, reject) {
        superagent.post('https://www.box.com/api/oauth2/token')
            .type('form')
            .send({grant_type: 'refresh_token'})
            .send({refresh_token: refreshToken})
            .send({client_id: process.env.CLIENT_ID})
            .send({client_secret: process.env.CLIENT_SECRET})
            .end(function(res) {
                console.log('Got response from new access token');
                if (res.error) return reject(res.error);
                resolve(res.body.access_token, res.body.refresh_token, Date.now() + res.body.expires_in * 1000);
            });
    });
}

function getSheetContent(fileID, accessToken, refreshToken, expires) {
    return new Promise(function(resolve, reject) {
        superagent.get('https://api.box.com/2.0/files/' + fileID + '/content')
            .set('Authorization', 'Bearer ' + accessToken)
            .redirects(0)
            .end(function(res) {
                console.log('Got response from sheet');
                if (res.error) return reject(res.error);

                request.get(res.headers.location, function(err, res, body) {
                    console.log('Got contents of sheet');
                    var body;
                    try {
                        body = JSON.parse(body);
                    } catch (e) {
                        reject(e);
                        return;
                    }
                    body.id = fileID;
                    body.accessToken = accessToken;
                    body.refreshToken = refreshToken;
                    body.tokenExpires = expires;
                    resolve(body);
                });
            });
    });
}
function getCollaborators(fileID, accessToken) {
    return new Promise(function(resolve, reject) {
        superagent.get('https://api.box.com/2.0/files/' + fileID + '?fields=parent,owned_by')
            .set('Authorization', 'Bearer ' + accessToken)
            .end(function(res) {
                if (res.error) return reject(res.error);
                var owner = res.body.owned_by;
                superagent.get('https://api.box.com/2.0/folders/' + res.body.parent.id + '/collaborations')
                    .set('Authorization', 'Bearer ' + accessToken)
                    .end(function(res) {
                        if (res.error) return reject(res.error);
                        resolve(res.body.entries.map(function(entry) {
                            return entry.accessible_by.name;
                        }).concat([owner.name]));
                    });
            });

    });
}


var ongoingRequests = {};

exports.get = function(fileID, auth) {
    var promise = new Promise(function(resolve, reject) {
        getAccessToken(auth).then(function(accessToken, refreshToken, expires) {
            console.log('Getting sheet content');
            if (fileID in ongoingRequests) {
                console.log('Already loading sheet, returning existing promise');
                return ongoingRequests[fileID];
            }
            ongoingRequests[fileID] = promise;

            // var collabPromise = getCollaborators(fileID, accessToken);
            getSheetContent(fileID, accessToken, refreshToken, expires).then(function(sheet) {
                resolve(sheet);
                delete ongoingRequests[fileID];
            }, reject);
        });
    });

    return promise;
};

exports.put = function(sheet) {
    return new Promise(function(resolve, reject) {
        function doPut() {
            var sheetData = JSON.stringify({
                contents: sheet.contents,
            });

            var sheetPath = '/tmp/sheet_' + sheet.id;
            fs.writeFile(sheetPath, sheetData, function() {
                superagent.post('https://upload.box.com/api/2.0/files/' + sheet.id + '/content')
                    .set('Authorization', 'Bearer ' + sheet.accessToken)
                    .attach('filename', sheetPath)
                    .end(function(res) {
                        if (res.error) return reject(res.error);
                        resolve(res.body);
                    });
            });

        }
        function refreshToken() {
            getNewAccessToken(sheet.refreshToken, function(err, accessToken, refreshToken, expires) {
                if (err) return reject(err);
                sheet.accessToken = accessToken;
                sheet.refreshToken = refreshToken;
                sheet.tokenExpires = tokenExpires;
                doPut();
            })
        }
        if (sheet.tokenExpires < Date.now() - 5000) {
            refreshToken();
        } else {
            doPut();
        }
    });
};
