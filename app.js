'use strict';

const
    bodyParser = require('body-parser'),
    config = require('config'),
    crypto = require('crypto'),
    express = require('express'),
    https = require('https'),
    request = require('request'),
    process = require('process'),
    url = require('url'),
    search = require('./modules/search-people'),
    CRLF = "\r\n";

var app = express(),
    dialogs = {},
    port,
    serverURLParsed,
    expiredCheckTime = +new Date() + config.get('dialogLifetime') * 1000;

const
    APP_SECRET = (process.env.MESSENGER_APP_SECRET) ? process.env.MESSENGER_APP_SECRET : config.get('appSecret'),
    VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ? (process.env.MESSENGER_VALIDATION_TOKEN) : config.get('validationToken'),
    PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ? (process.env.MESSENGER_PAGE_ACCESS_TOKEN) : config.get('pageAccessToken'),
    SERVER_URL = (process.env.SERVER_URL) ? (process.env.SERVER_URL) : config.get('serverURL');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
    console.error('Missing config values');
    process.exit(1);
}

serverURLParsed = url.parse(SERVER_URL);

// Отключить проверку сертификата не для эксплуатационной площадки.
if (process.env.NODE_ENV !== 'production') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

app
    .set('port', process.env.PORT || serverURLParsed.port || 80)
    .set('host', process.env.HOST || serverURLParsed.hostname || 'localhost')
    .set('view engine', 'ejs')
    .use(bodyParser.json({verify: verifyRequestSignature}))
    .use(express.static('public'));

/*
 * Check that the token used in the Webhook setup is the same token used here.
 */
app.get('/', function (req, res) {

    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VALIDATION_TOKEN) {
        console.log('Validating webhook');
        res.status(200).send(req.query['hub.challenge']);

    } else {
        console.error('Failed validation. Make sure the validation tokens match.');
        res.sendStatus(403);
    }

});

function createDialog(recipientID, restart = false) {

    if (restart && dialogs[recipientID]) {

        dialogs[recipientID] = {
            answers: dialogs[recipientID].answers,
            foundProfiles: [],
            currentProfile: 0,
            time: +new Date(),
            greetingSent: true
        };

        Object.keys(dialogs[recipientID].answers).forEach(function (key) {

            if (!config.dialog.questions[+key].persistent) {
                delete dialogs[recipientID].answers[key];
            }

        });

    } else {

        dialogs[recipientID] = {
            answers: {},
            foundProfiles: [],
            currentProfile: 0,
            time: +new Date(),
            greetingSent: false
        };

    }

}

function checkExpiredDialogs() {

    if (+new Date() - expiredCheckTime < config.get('dialogLifetime') * 1000) {
        return;
    }

    Object.keys(dialogs).forEach(function (customerID) {

        if (dialogs[customerID].time <= expiredCheckTime) {
            delete dialogs[customerID];
        }

    });

    expiredCheckTime = +new Date() + config.get('dialogLifetime') * 1000;
}

/*
 * All callbacks for Messenger are POST-ed.
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 */
app.post('/', function (req, res) {
    var data = req.body;

    // Make sure this is a page subscription
    if (data.object !== 'page') {
        return;
    }

    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function (pageEntry) {

        pageEntry.messaging.forEach(function (messagingEvent) {
            let senderID = messagingEvent.sender.id;

            if (!dialogs[senderID]) {
                createDialog(senderID);
            }

            dialogs[senderID].time = +new Date();

            if (messagingEvent.optin) {
                receivedAuthentication(messagingEvent);

            } else if (messagingEvent.delivery) {
                receivedDeliveryConfirmation(messagingEvent);

            } else if (messagingEvent.read) {
                receivedMessageRead(messagingEvent);

            } else if (messagingEvent.account_linking) {
                receivedAccountLink(messagingEvent);

            } else if (messagingEvent.postback) {
                let payload = messagingEvent.postback.payload;

                if (payload === 'need-help') {
                    sendNeedHelp(senderID);

                } else if (payload === 'NEW_THREAD') {
                    let timeout = dialogs[senderID].greetingSent ? 0 : 3000;
                    createDialog(senderID);
                    //sendGreeting(senderID);

                    setTimeout(function () {
                        sendQuestion(senderID);
                    }, timeout);

                } else if (payload === 'restart') {
                    createDialog(senderID, true);
                    sendQuestion(senderID);

                } else if (payload === 'next') {
                    //todo: обработать ситуацию, когда диалог уже протух
                    sendFoundProfile(senderID, function () {});

                } else {
                    let payload = JSON.parse(messagingEvent.postback.payload);
                    receivedPostback(messagingEvent);
                    dialogs[senderID].answers[payload.id] = payload.answer;
                    sendQuestion(senderID);
                }

            } else if (messagingEvent.message) {

                if (messagingEvent.message.quick_reply) {
                    let payload = JSON.parse(messagingEvent.message.quick_reply.payload);
                    dialogs[senderID].answers[payload.id] = payload.answer;
                    sendQuestion(senderID);
                } else {
                    receivedMessage(messagingEvent);
                }

            } else {
                console.log('Webhook received unknown messagingEvent "', messagingEvent + '"');
            }

        });
    });

    checkExpiredDialogs();
    res.sendStatus(200);
});

/*
 * This path is used for account linking. The account linking call-to-action
 * (sendAccountLinking) is pointed to this URL.
 *
 */
app.get('/authorize', function (req, res) {
    var accountLinkingToken = req.query.account_linking_token;
    var redirectURI = req.query.redirect_uri;

    // Authorization Code should be generated per user by the developer. This will
    // be passed to the Account Linking callback.
    var authCode = "1234567890";

    // Redirect users to this URI on successful login
    var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;

    res.render('authorize', {
        accountLinkingToken: accountLinkingToken,
        redirectURI: redirectURI,
        redirectURISuccess: redirectURISuccess
    });
});

/*
 * Verify that the callback came from Facebook. Using the App Secret from
 * the App Dashboard, we can verify the signature that is sent with each
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
    var signature = req.headers['x-hub-signature'];

    if (!signature) {
        // log an error, in production, you should throw an error.
        console.error('Couldn\'t validate the signature.');
    } else {
        let elements = signature.split('='),
            signatureHash = elements[1],
            expectedHash = crypto
                .createHmac('sha1', APP_SECRET)
                .update(buf)
                .digest('hex');

        if (signatureHash !== expectedHash) {
            throw new Error('Couldn\'t validate the request signature.');
        }

    }

}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to
 * Messenger" plugin, it is the 'data-ref' field. Read more at
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
    var senderID = event.sender.id,
        recipientID = event.recipient.id,
        timeOfAuth = event.timestamp,
        passThroughParam;

    // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
    // The developer can set this to an arbitrary value to associate the
    // authentication callback with the 'Send to Messenger' click event. This is
    // a way to do account linking when the user clicks the 'Send to Messenger'
    // plugin.
    passThroughParam = event.optin.ref;
    console.log("Received authentication for user %d and page %d with pass " + "through param '%s' at %d", senderID, recipientID, passThroughParam, timeOfAuth);

    // When an authentication is received, we'll send a message back to the sender
    // to let them know it was successful.
    sendTextMessage(senderID, "Authentication successful");
}

/*
 * Message Event
 *
 * This event is called when a message is sent to your page. The 'message'
 * object format can vary depending on the kind of message that was received.
 * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 *
 * For this example, we're going to echo any text that we get. If we get some
 * special keywords ('button', 'generic', 'receipt'), then we'll send back
 * examples of those bubbles to illustrate the special message bubbles we've
 * created. If we receive a message with an attachment (image, video, audio),
 * then we'll simply confirm that we've received the attachment.
 *
 */
function receivedMessage(event) {
    var senderID = event.sender.id,
        recipientID = event.recipient.id,
        timeOfMessage = event.timestamp,
        message = event.message,
        isEcho = message.is_echo,
        messageId = message.mid,
        appId = message.app_id,
        metadata = message.metadata,
        messageText = message.text,
        messageAttachments = message.attachments,
        quickReply = message.quick_reply;

    console.log('Received message for user %d and page %d at %d with message:', senderID, recipientID, timeOfMessage);
    console.log(JSON.stringify(message));

    if (dialogs[senderID] && Object.keys(dialogs[senderID].answers).length) {
        callSendAPI(generateDefaultMenu(senderID, config.dialog.texts.defaultMessage));
    } else {
        let timeout = dialogs[senderID].greetingSent ? 0 : 3000;
        createDialog(senderID, true);
        //sendGreeting(senderID);

        setTimeout(function () {
            sendQuestion(senderID);
        }, timeout);

    }
}

function sendGreeting(recipientID) {
    var message = config.has('dialog.texts.greetingDialogMessage') && config.get('dialog.texts.greetingDialogMessage');

    if (!dialogs[recipientID].greetingSent && message) {
        dialogs[recipientID].greetingSent = true;

        callSendAPI({

            recipient: {
                id: recipientID
            },

            message: {
                text: message
            }

        });

    }

}

function sendNeedHelp(recipientID) {

    callSendAPI({

        recipient: {
            id: recipientID
        },

        message: {
            text: config.get('dialog.texts.support')
        }

    });

}

function sendQuestion(recipientID) {
    var question,
        data,
        currentQuestion = null;

    config.dialog.questions.forEach(function (value, i) {

        if (currentQuestion === null && typeof dialogs[recipientID].answers[i] === 'undefined') {
            currentQuestion = i;
        }

    });

    if (currentQuestion === null) {
        sendFoundProfile(recipientID, function () {});
        return;
    }

    question = config.dialog.questions[currentQuestion];

    if (question.type === 'button') {
        data = generateQuestion(recipientID, currentQuestion);
        callSendAPI(data);

    } else if (question.type === 'quickReply') {
        data = generateQuickReplies(recipientID, currentQuestion);
        callSendAPI(data);
    }

}

function getSearchCriteria(answers) {
    var criteria = {};

    Object.keys(answers).forEach(function (questionNumber) {
        var answer = +answers[questionNumber],
            searchParams = config.dialog.questions[questionNumber] &&
                config.dialog.questions[questionNumber].searchParams &&
                config.dialog.questions[questionNumber].searchParams[answer];

        if (searchParams) {

            Object.keys(searchParams).forEach(function (paramName) {
                criteria[paramName] = searchParams[paramName];
            });

        }
    });

    return criteria;
}

function sendFoundProfile(recipientID, callback) {
    var currentProfile;

    if (dialogs[recipientID].foundProfiles.length) {
        let lastProfile;

        if (dialogs[recipientID].foundProfiles.length > dialogs[recipientID].currentProfile) {
            callback(true);
        }

        currentProfile = dialogs[recipientID].foundProfiles[dialogs[recipientID].currentProfile];
        dialogs[recipientID].currentProfile += 1;
        lastProfile = dialogs[recipientID].currentProfile === dialogs[recipientID].foundProfiles.length;
        callSendAPI(generateProfileInfo(recipientID, currentProfile, lastProfile));
        callback();
        return;
    }

    sendTypingOn(recipientID);

    search(getSearchCriteria(dialogs[recipientID].answers), function (err, data) {

        if (!err && data.length) {
            dialogs[recipientID].foundProfiles = data;
            dialogs[recipientID].currentProfile = 0;
            sendFoundProfile(recipientID, callback);
        } else {
            callback('empty');
            callSendAPI(generateNoProfilesMenu(recipientID, config.dialog.texts.noPeopleFound));
        }

    });

}

/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
    var senderID = event.sender.id,
        recipientID = event.recipient.id,
        delivery = event.delivery,
        messageIDs = delivery.mids,
        watermark = delivery.watermark,
        sequenceNumber = delivery.seq;

    if (messageIDs) {

        messageIDs.forEach(function (messageID) {
            console.log("Received delivery confirmation for message ID: %s", messageID);
        });

    }

    console.log('All message before %d were delivered.', watermark);
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 *
 */
function receivedPostback(event) {
    var senderID = event.sender.id,
        recipientID = event.recipient.id,
        timeOfPostback = event.timestamp,
        payload = event.postback.payload;

    console.log("Received postback for user %d and page %d with payload '%s' at %d", senderID, recipientID, payload, timeOfPostback);
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 *
 */
function receivedMessageRead(event) {
    var senderID = event.sender.id,
        recipientID = event.recipient.id,
        // All messages before watermark (a timestamp) or sequence have been seen.
        watermark = event.read.watermark,
        sequenceNumber = event.read.seq;

    console.log('Received message read event for watermark %d and sequence number %d', watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 *
 */
function receivedAccountLink(event) {
    var senderID = event.sender.id,
        recipientID = event.recipient.id,
        status = event.account_linking.status,
        authCode = event.account_linking.authorization_code;

    console.log('Received account link event with for user %d with status %s and auth code %s ', senderID, status, authCode);
}

/*
 * Send a text message using the Send API.
 *
 */
function sendTextMessage(recipientId, messageText) {
    var messageData = {
        recipient: {
            id: recipientId
        },
        message: {
            text: messageText,
            metadata: "DEVELOPER_DEFINED_METADATA"
        }
    };

    callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll
 * get the message id in a response
 *
 */
function callSendAPI(messageData) {

    request({
        uri: config.get('facebookGraphURL') + 'messages',
        qs: {access_token: PAGE_ACCESS_TOKEN},
        method: 'POST',
        json: messageData

    }, function (error, response, body) {

        if (!error && response.statusCode === 200) {
            let recipientId = body.recipient_id,
                messageId = body.message_id;

            if (messageId) {
                console.log('Successfully sent message with id %s to recipient %s', messageId, recipientId);
            } else {
                console.log('Successfully called Send API for recipient %s', recipientId);
            }

        } else {
            console.error('Failed calling Send API', response.statusCode, response.statusMessage, body.error);
        }

    });

}

function sendTypingOn(recipientID) {

    callSendAPI({

        recipient: {
            id: recipientID
        },

        sender_action: 'typing_on'
    });

}

function generateQuestion(recipientID, questionID) {
    var question = config.dialog.questions[questionID],
        greetingMessage = config.has('dialog.texts.greetingDialogMessage') && config.get('dialog.texts.greetingDialogMessage');

    if (!+questionID && !dialogs[recipientID].greetingSent && greetingMessage) {
        dialogs[recipientID].greetingSent = true;
        question.question = greetingMessage + CRLF + CRLF + question.question;
    }

    return {

        recipient: {
            id: recipientID
        },

        message: {

            attachment: {
                type: 'template',

                payload: {
                    template_type: 'button',
                    text: question.question,

                    buttons: question.answers.map(function (answer, i) {

                        return {
                            type: 'postback',
                            title: answer,

                            payload: JSON.stringify({
                                id: questionID,
                                answer: i
                            })

                        };

                    })

                }

            }

        }

    }

}

function generateQuickReplies(recipientID, questionID) {
    var question = config.dialog.questions[questionID],
        message = question.question,
        greetingMessage = config.has('dialog.texts.greetingDialogMessage') && config.get('dialog.texts.greetingDialogMessage');

    if (questionID === 0 && !dialogs[recipientID].greetingSent && greetingMessage) {
        dialogs[recipientID].greetingSent = true;
        message = greetingMessage + CRLF + CRLF + message;
    }

    return {

        recipient: {
            id: recipientID
        },

        message: {
            text: message,

            quick_replies: question.answers.map(function (answer, i) {

                return {
                    content_type: 'text',
                    title: answer,

                    payload: JSON.stringify({
                        id: questionID,
                        answer: i
                    })

                };

            })

        }

    }

}

function generateProfileInfo(recipientID, data, last) {

    var buttons = [

        {
            type: 'web_url',
            url: data.profileURL,
            title: config.dialog.texts.viewProfile
        }

    ];


    if (last) {

        buttons.push({
            type: 'web_url',
            url: addAFID(config.dialog.projectLanding),
            title: config.dialog.texts.followProject
        });

        buttons.push({
            type: 'postback',
            title: config.dialog.texts.needHelp,
            payload: 'need-help'
        });

    } else {

        buttons.push({
            type: 'postback',
            title: config.dialog.texts.nextProfile,
            payload: 'next'
        });

    }

    return {

        recipient: {
            id: recipientID
        },

        message: {
            attachment: {
                type: 'template',

                payload: {
                    template_type: 'generic',

                    elements: [

                        {
                            title: data.title,
                            image_url: data.imageURL,
                            subtitle: data.details,

                            default_action: {
                                type: 'web_url',
                                url: data.profileURL
                            },

                            buttons: buttons
                        }

                    ]

                }

            }

        }

    }

}

function generateDefaultMenu(recipientID, message) {

    return {

        recipient: {
            id: recipientID
        },

        message: {

            attachment: {
                type: 'template',

                payload: {
                    template_type: 'button',
                    text: message,

                    buttons: [

                        {
                            type: 'web_url',
                            url: addAFID(config.dialog.projectLanding),
                            title: config.dialog.texts.followProject
                        },

                        {
                            type: 'postback',
                            title: config.dialog.texts.needHelp,
                            payload: 'need-help'
                        }

                    ]

                }

            }

        }

    };

}

function generateNoProfilesMenu(recipientID, message) {

    return {

        recipient: {
            id: recipientID
        },

        message: {

            attachment: {
                type: 'template',

                payload: {
                    template_type: 'button',
                    text: message,

                    buttons: [

                        {
                            type: 'web_url',
                            url: addAFID(config.dialog.projectLanding),
                            title: config.dialog.texts.followProject
                        },

                        {
                            type: 'postback',
                            title: config.dialog.texts.changeSettings,
                            payload: 'restart'
                        }

                    ]

                }

            }

        }

    };

}

function addAFID(urlAddress) {
    var parsed;

    if (!config.has('afid') || !config.get('afid')) {
        return;
    }

    parsed = url.parse(urlAddress);
    parsed.search = (parsed.search ? parsed.search + '&' : '') + 'afid=' + config.get('afid');
    return url.format(parsed);
}

app.listen(app.get('port'), app.get('host'), function () {
    console.log('Node app is running on port', app.get('port'));
});

module.exports = app;
