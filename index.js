'use strict';
let express = require('express'),
    bodyParser = require('body-parser'),
    app = express(),
    request = require('request'),
    config = require('config');

let messages = require('./supportive-messages');

const mongodb = require('mongodb');

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

let users = {};

app.listen(8989, () => console.log('Daily stress assist app listening on port 8989!'));

app.get('/', (req, res) => res.send('Daily stress assist up and running! ;)'));

app.post('/webhook', (req, res) => {
  let body = req.body;
  if (body.object === 'page') {
    body.entry.forEach(function(entry) {
      let webhook_event = entry.messaging[0];
      let sender_psid = webhook_event.sender.id;
      if (webhook_event.message) {
        console.log("webhook received a message to process");
        if (config.get("mode") != "bot") {
          setTimeout(function(){
            callTypingOn(sender_psid)
          }, 5000);
          setTimeout(function(){
            handleMessage(sender_psid, webhook_event.message)
          }, 10000);
        } else {
          handleMessage(sender_psid, webhook_event.message);
        }
      } else if (webhook_event.postback) {
        handlePostback(sender_psid, webhook_event.postback);
      }
    });
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

app.get('/webhook', (req, res) => {
  let VERIFY_TOKEN = config.get('token_to_verify_webhook');
  let mode = req.query['hub.mode'];
  let token = req.query['hub.verify_token'];
  let challenge = req.query['hub.challenge'];
  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

function handleMessage(sender_psid, received_message) {
  console.log("entering handleMessage...");
  let n_words = received_message.text.split(" ").length;
  if (received_message.text && n_words > 10) {
    let sentiment = "undefined"
    analyzeSentiment(received_message.text).then(
      res => {
        if (res == "negative") {
          getResponseFromWatson(received_message.text).then(
            res => {
              getResponseFromTemplates(sender_psid, res).then(
                res => {
                  callSendAPI(sender_psid, res);
                });
            });
        }
      });
  }
}

function saveMessageFromUser(messageFromUser, classificationByWatson) {
  let uri = config.get("mongodb.uri");
  mongodb.MongoClient.connect(uri, {useNewUrlParser: true}, function(err, client) {
    if(err) throw err;
    let db = client.db(config.get("mongodb.db"));
    let messages = db.collection(config.get("mongodb.collection_messages"));
    let newMessage = {
      message: messageFromUser,
      classification: classificationByWatson
    }
    messages.insertOne(newMessage, function(err, result) {
      if (err) throw err;
    });
    client.close(function (err) {
      if(err) throw err;
    });
  });
}

function getResponseFromTemplates(sender_psid, strategy) {
  return new Promise(function(resolve, reject) {
    let messageToReturn = "";
    let uri = config.get("mongodb.uri");
    mongodb.MongoClient.connect(uri, {useNewUrlParser: true}, function(err, client) {
      if(err) throw err;
      let db = client.db(config.get("mongodb.db"));
      let users = db.collection(config.get("mongodb.collection_users"));
      users.findOne({ user_id: sender_psid }, function(err, result) {
        if (err) throw err;
        if (result == null) {
          let newUser = {
            user_id: sender_psid,
            user_GES: 0,
            user_GES_GRIEF: 0,
            user_AD: 0,
            user_CC: 0,
            user_SM: 0
          }
          resolve(STRATEGIES[strategy.toLowerCase()][0]);
          newUser["user_"+strategy] = 1;
          users.insertOne(newUser, function(err, result) {
            if (err) throw err;
          });
        } else {
          resolve(STRATEGIES[strategy.toLowerCase()][result["user_"+strategy]]);
          let newValue = 0;
          let fieldToUpdate = "user_"+strategy;
          if (result["user_"+strategy] != STRATEGIES[strategy.toLowerCase()].length - 1) {
            newValue = result["user_"+strategy] + 1;
          }
          users.updateOne(
            { user_id: result["user_id"] },
            { $set: { [fieldToUpdate]:  newValue } },
            function (err, result) {
              if (err) throw err;
            }
          );
        }
        client.close(function (err) {
          if(err) throw err;
        });
      });
    });
  })
}

function callTypingOn(sender_psid, cb = null) {
  let request_body = {
      "recipient": {
          "id": sender_psid
      },
      "sender_action":"typing_on"
  };
  request({
      "uri": "https://graph.facebook.com/v3.1/me/messages",
      "qs": { "access_token": config.get('facebook.page.access_token') },
      "method": "POST",
      "json": request_body
  }, (err, res, body) => {
      if (!err) {
          if(cb){
              cb();
          }
      } else {
          console.error("Unable to do the request: " + err);
      }
  });
}

function callSendAPI(sender_psid, response, cb = null) {
  let request_body = {
      "messaging_type": "RESPONSE",
      "recipient": {
          "id": sender_psid
      },
      "message": {
        "text": response
      }
  };
  request({
      "uri": "https://graph.facebook.com/v3.1/me/messages",
      "qs": { "access_token": config.get('facebook.page.access_token') },
      "method": "POST",
      "json": request_body
  }, (err, res, body) => {
      if (!err) {
          if(cb){
              cb();
          }
      } else {
          console.error("Unable to send message: " + err);
      }
  });
}

var NaturalLanguageUnderstandingV1 = require('./node_modules/watson-developer-cloud/natural-language-understanding/v1.js');
var nlu = new NaturalLanguageUnderstandingV1({
  username: config.get("ibm_watson.natural_language_understanding.username"),
  password: config.get("ibm_watson.natural_language_understanding.password"),
  version: '2018-04-05',
  url: 'https://gateway.watsonplatform.net/natural-language-understanding/api/'
});

function analyzeSentiment(messageToAnalyze) {
  var options = {
    text: messageToAnalyze,
    features: {
      sentiment: {}
    }
  };
  return new Promise(function(resolve, reject) {
    nlu.analyze(options, function(err, res) {
      if (err) {
        console.log(err);
        reject(err);
      }
      resolve(res['sentiment']['document']['label']);
    });
  })
}

var AssistantV1 = require('watson-developer-cloud/assistant/v1');
var assistant = new AssistantV1({
  username: config.get("ibm_watson.assistant.username"),
  password: config.get("ibm_watson.assistant.password"),
  url: 'https://gateway.watsonplatform.net/assistant/api/',
  version: '2018-09-19'
});

function getResponseFromWatson(inputFromUser) {
  return new Promise(function(resolve, reject) {
    assistant.message(
      {
        input: {text: inputFromUser},
        workspace_id:  config.get("ibm_watson.assistant.workspace_id")
      },
      function(err, response) {
        if (err) {
          reject(err);
        } else {
          saveMessageFromUser(inputFromUser, response["entities"]);
          resolve(response["output"]["generic"][0]["text"]);
        }
      }
    )
  })
}
