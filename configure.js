var config = require('config'),
    request = require('request'),
    url = require('url');

const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ? (process.env.MESSENGER_PAGE_ACCESS_TOKEN) : config.get('pageAccessToken');

if (!PAGE_ACCESS_TOKEN) {
    console.error("Missing config value \"pageAccessToken\"");
    process.exit(1);
}

function configure(type, data, method) {
    data = data || {};

    request({
        uri: config.get('facebookGraphURL') + type,

        qs: {
            access_token: PAGE_ACCESS_TOKEN
        },

        method: method || 'POST',
        json: data
    }, function (error, response, body) {

        if (!error && response.statusCode === 200) {
            console.log('Facebook application configure success for "' + type + (data.setting_type ? '.' + data.setting_type : '') + '"' + (body.result ? ' (' + body.result + ')' : ''));
            //TODO: логгировать

        } else {
            console.error('Facebook application configure failed for "' + type + (data.setting_type ? '.' + data.setting_type : '') + '"', response.statusCode, response.statusMessage, body.error);
            //TODO: логгировать
        }

    });

}

// Установка доверенных доменов
if (config.has('whitelistDomains')) {

    configure('thread_settings', {
        setting_type: 'domain_whitelisting',
        whitelisted_domains: config.has('whitelistDomains') && config.get('whitelistDomains') || [],
        domain_action_type: 'add'
    });

}

// Подписка приложения на Страницу
configure('subscribed_apps');

// Установка приветственного сообщения
if (config.has('dialog.texts.greetingMessage')) {

    configure('thread_settings', {
        setting_type: 'greeting',

        greeting: {
            text: config.get('dialog.texts.greetingMessage')
        }

    });

} else {

    configure('thread_settings', {
        setting_type: 'greeting',
    }, 'DELETE');

}

// Установка кнопки Get Started
if (config.has('dialog.getStartedButton') && config.get('dialog.getStartedButton')) {

    configure('thread_settings', {

        setting_type: 'call_to_actions',
        thread_state: 'new_thread',

        call_to_actions: [

            {
                payload: 'NEW_THREAD'
            }

        ]

    });

} else {

    configure('thread_settings', {
        setting_type: 'call_to_actions',
        thread_state: 'new_thread'
    }, 'DELETE');

}

//if (!config.has('dialog.getStartedButton') || !config.get('dialog.getStartedButton')) {

    configure('thread_settings', {

        setting_type: 'call_to_actions',
        thread_state: 'existing_thread',

        call_to_actions: [
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

    });

//}

function addAFID(urlAddress) {
    var parsed;

    if (!config.has('afid') || !config.get('afid')) {
        return;
    }

    parsed = url.parse(urlAddress);
    parsed.search = (parsed.search ? parsed.search + '&' : '') + 'afid=' + config.get('afid');
    return url.format(parsed);
}

