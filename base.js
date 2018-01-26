
'use strict';

var version = '0.0.15';

console.log("base v" + version);
console.log("official site: basechain.io ");

var elliptic = require('elliptic');
var Signature = require('elliptic/lib/elliptic/ec/signature');
var curve = elliptic.curves['ed25519'];
var ecdsa = new elliptic.ec(curve);
var express = require("express");
var WebSocket = require("ws");
var CryptoJS = require("crypto-js");
var bodyParser = require('body-parser');
var fs = require("fs");
var http = require('https');
//heroku postgres
var pg = require('pg');

var http_port = process.env.HTTP_PORT || 3001;
var p2p_port = process.env.PORT || 6001;
var storage = process.env.STORAGE || 'FILE';
var sockets = [];

var peers = [];
var transactions = [];
var blockchain = [];

var MessageType = {
    QUERY_LATEST_BLOCK: 0,
    QUERY_ALL_BLOCKS: 1,
    QUERY_LATEST_TRANSACTION: 2,
    QUERY_ALL_TRANSACTIONS: 3,
    RESPONSE_BLOCKCHAIN: 4,
    RESPONSE_TRANSACTION: 5
};

class Block {
    constructor(index, previousHash, timestamp, data, nonce, hash, difficulty_a, difficulty_b) {
        this.index = index;
        this.previousHash = previousHash.toString();
        this.timestamp = timestamp;
        this.data = data;
        this.nonce = nonce;
        this.hash = hash.toString();
        this.difficulty_a = difficulty_a;
        this.difficulty_b = difficulty_b;
    }
}

class Transaction {
    constructor(hash, timestamp, inputs, outputs, signatures) {
        this.hash = hash;
        this.timestamp = timestamp;
        this.inputs = inputs;
        this.outputs = outputs;
        this.signatures = signatures;
    }
}

class Input {
    constructor(fromBlockIndex, fromTxHash, fromOutputIndex, fromPK) {
        this.fromBlockIndex = fromBlockIndex;
        this.fromTxHash = fromTxHash;
        this.fromOutputIndex = fromOutputIndex;
        this.fromPK = fromPK;
    }
}

class Output {
    constructor(toHash, amount) {
        this.toHash = toHash;
        this.amount = amount
    }
}

var makeTransaction = (timestamp, inputs, outputs, sks) => {
    var msg = {
        timestamp: timestamp,
        inputs: inputs,
        outputs: outputs
    };
    var msgHash = CryptoJS.SHA256(JSON.stringify(msg)).toString();
    var signatures = [];
    var signature;
    sks.forEach((sk) => {
        signature = ecdsa.sign(msgHash, sk).toDER('hex');
        signatures.push(signature);
    });
    var t = new Transaction(msgHash, timestamp, inputs, outputs, signatures);
    return (t);
}

var calculateHashForBlock = (block) => {
    return calculateHash(block.index, block.previousHash, block.timestamp, block.nonce, block.data, block.difficulty_a, block.difficulty_b);
};

var calculateHash = (index, previousHash, timestamp, nonce, data, difficulty_a, difficulty_b) => {
    return CryptoJS.SHA256(index + previousHash + timestamp + nonce + data + difficulty_a + difficulty_b).toString();
};

var getGenesisBlock = () => {
    var inputs = [];
    //var coinbase_pk = '';
    //var genesis_coinbase_hash = CryptoJS.SHA256(coinbase_pk).toString();
    var genesis_coinbase_hash = 'f0c8b63451ee734fe4d7bb5c7dedd71a8a826f1b599fe50074c490456957f572';
    var outputs = [new Output(genesis_coinbase_hash, 2000000)];
    var secret_keys = [];
    var genesis_timestamp = 1465154705;
    var genesis_coinbase_tx = JSON.stringify(makeTransaction(genesis_timestamp, inputs, outputs, secret_keys));
    var block = new Block(
        0,
        "0",
        genesis_timestamp,
        [genesis_coinbase_tx],
        0,
        "9408ca0a0763cab86ea5f09766290bd2cbdbe75610b44b104b91b2b0279625ad",
        1,
        0xf
    );
    console.log('genesis hash: ' + calculateHashForBlock(block));
    return block;
};

//save chain 

var saveChain = (data) => {
    if (storage == 'FILE') {
        //save chain to local disk
        fs.writeFile('blockchain.txt', data, function (error) {
            if (error) {
                console.error("ERROR: base could not create a new blockchain data file: " + error.message);
                return;
            }
            else {
                console.log('saved local blockchain file');
            }
        });
    }
    else {
        //save chain to heroku/postgres
        pg.connect(process.env.DATABASE_URL, function (err, client, done) {
            client.query("UPDATE blocktable SET blockdata ='" + data + "'; ", function (err, result) {
                if (err) {
                    console.error(err); response.send("Error " + err);
                }
                else {
                    console.log('saved blockchain to db. data=' + data);
                }
            });
        });
    }
}

//load chain 

if (storage == 'FILE') {
    try {
        //load the blockchain from local disk 
        var blockchain_data = fs.readFileSync('blockchain.txt');
        blockchain = JSON.parse(blockchain_data);
        console.log('loaded blockchain file. length=' + blockchain.length);
    }
    catch (err) {
        //no blockchain data file, so make one
        blockchain = [getGenesisBlock()];
        var data = JSON.stringify(blockchain);
        saveChain(data);
    }
}
else {
    //load the blockchain from heroku postgresDB  
    pg.connect(process.env.DATABASE_URL, function (err, client, done) {
        client.query('SELECT blockdata FROM blocktable', function (err, result) {
            if (err) {
                console.log('ERROR: failed to get data from postgres database. Try using environment variable STORAGE=FILE. ');
                console.error(err);
                process.exit();
            }
            else {
                console.log('returned data stringified=' + JSON.stringify(result.rows[0].blockdata));
                var blockchain_data = result.rows[0].blockdata;
                console.log(blockchain_data);
                blockchain = JSON.parse(blockchain_data);
                console.log('loaded blockchain from db. length=' + blockchain.length);
            }
        });
    });
}





//save peers 

var savePeers = (data) => {
    console.log('save peer: ' + data);
    if (storage == 'FILE') {
        //save peers to local disk
        fs.writeFile('peers.txt', data, function (error) {
            if (error) {
                console.error("ERROR: base could not create a new peer data file: " + error.message);
                return;
            }
            else {
                console.log('saved peer file');
            }
        });
    }
    else {
        //save peers to heroku/postgres
        try {
            var peers_to_save = JSON.parse(data);
            var len = peers_to_save.length;
            var sql = 'INSERT INTO "Peers" (Address, DateStamp) VALUES ';
            for (var i = 0; i < len; i++) {
                sql = sql + " ('" + peers_to_save[i] + "', '" + getTimestamp() + "')";
                if (i < (len - 1)) {
                    sql = sql + ", ";
                }
            }
            sql = sql + " ON CONFLICT (id) DO UPDATE SET DateStamp = excluded.DateStamp;";
            console.log(sql);
            //upsert the data
            pg.connect(process.env.DATABASE_URL, function (err, client, done) {
                client.query(sql, function (err, result) {
                    if (err) {
                        console.error(err);
                        console.log("Error saving peers to db " + err);
                    }
                    else {
                        console.log('saved peers to db. data=' + data);
                    }
                });
            });
            console.log('updated peers');
        }
        catch (err) {
            console.log('ERROR: savePeers');
            console.log(err);
        }
    }
}


//load peers 

if (storage == 'FILE') {
    console.log('loading peers from disk');
    var peer_data;
    try {
        //load the peers from local disk 
        peer_data = fs.readFileSync('peers.txt');
        peers = JSON.parse(peer_data);     
        console.log(peers);
    }
    catch (err) {
        console.log('could not load or parse peers from disk: ' + peer_data);
        //no peer file, so make one and point to heroku
        peers = ['54.247.80.217:80'];
        savePeers(JSON.stringify(peers));
    }
}
else {

    //load the peers from heroku postgresDB  
    pg.connect(process.env.DATABASE_URL, function (err, client, done) {
        try {
            client.query('SELECT "Address", "DateStamp" FROM "Peers" ', function (err, result) {
                if (err) {
                    console.log('ERROR: failed to load peers from postgres database(2). ');
                    console.error(err);
                    //process.exit();
                }
                else {
                    console.log('loading peers from db..');
                    //push peers loaded from db
                    result.rows.forEach(function (row) {
                        var loadp = row.Address.toString();
                        console.log('loading peer ' + loadp);
                        peers.push(loadp);
                    });
                    //console.log('loaded peers from db.');
                    //console.log(peers);
                }
            });
        }
        catch (err) {
            console.log('WARNING: could not load peers from database');
            console.log(err);
        }
    });

}

var getVersion = () => {
    var options = {
        host: 'raw.githubusercontent.com',
        path: '/basecrypto/base/master/version.txt'
    }
    var request = http.request(options, function (res) {
        var data = '';
        res.on('data', function (chunk) {
            data += chunk;
        });
        res.on('end', function () {
            //console.log(data);
            if (data.indexOf(version) != 0) {
                console.log('=============================================================================');
                console.log('your base installation is out of date. please re-install the lastest version.');
                console.log('=============================================================================');
                console.log('your vesion: ' + version);
                console.log('latest vesion: ' + data);
                process.exit();
            }
        });
    });
    request.on('error', function (e) {
        console.log(e.message);
    });

    request.end();
}
var initHttpServer = () => {

    var app = express();

    app.use(function (req, res, next) {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
        next();
    });

    app.use(bodyParser.json());

    app.get('/blocks', (req, res) => {
        console.log('GET /blocks');
        res.set("Connection", "close");
        res.send(JSON.stringify(blockchain));
    });

    app.get('/transactions', (req, res) => {
        console.log('GET /transactions');
        res.set("Connection", "close");
        res.send(JSON.stringify(transactions))
    });


    app.post('/mineBlock', (req, res) => {
        console.log('POST /mineBlock');
        var miner_pk = req.body.minerPK;
        var max_time_s = parseInt(req.body.maxSeconds);
        console.log('miner_pk=' + miner_pk);
        console.log('max_time_s' + max_time_s);
        var newBlock = generateNextBlock(transactions, miner_pk, max_time_s);
        if (newBlock) {
            if (addBlock(newBlock) == true) {
                broadcast(responseLatestBlockMsg());
                console.log('block added: ' + JSON.stringify(newBlock));
                res.set("Connection", "close");
                res.send(JSON.stringify(newBlock));
            }
            else {
                res.set("Connection", "close");
                res.send('could not mine block in the given time(1).');
            }
        }
        else {
            console.log('could not mine a block in the given time(2).');
            res.set("Connection", "close");
            res.send('could not mine block.');
        }
    });

    app.post('/balance', (req, res) => {
        var pk = req.body.pk;        
        var outputs = getUnspentOutputs(pk);
        res.set("Connection", "close");
        res.send(JSON.stringify(outputs));
    });

    app.post('/hash', (req, res) => {
        console.log('POST /hash');
        var pk = req.body.pk;
        var hash = CryptoJS.SHA256(pk).toString();
        res.set("Connection", "close");
        res.send(hash);
    });

    app.get('/peers', (req, res) => {
        res.set("Connection", "close");
        res.send(sockets.map(s => s._socket.remoteAddress + ':' + s._socket.remotePort));
    });

    app.post('/addPeer', (req, res) => {
        connectToPeers([req.body.peer]);
        res.set("Connection", "close");
        res.send();
    });

    app.get('/newWallet', (req, res) => {
        var keys = ecdsa.genKeyPair();
        var pk = keys.getPublic('hex');
        var sk = keys.getPrivate('hex');
        res.set("Connection", "close");
        res.send(JSON.stringify({ 'sk': sk, 'pk': pk }));
    });

    app.post('/pay', (req, res) => {
        console.log('POST /pay');
        var inputs = req.body.inputs;
        var outputs = req.body.outputs;
        var secret_keys = req.body.secret_keys;
        var timestamp = getTimestamp();
        var newTransaction = makeTransaction(timestamp, inputs, outputs, secret_keys);
        addTransaction(newTransaction);
        broadcast(responseLatestTransactionMsg(newTransaction));
        console.log('transaction added: ' + JSON.stringify(newTransaction));
        res.set("Connection", "close");
        res.send();
    });

    app.listen(http_port, () => console.log('listening for http on port ' + http_port));

};

var getTimestamp = () => {
    return Math.floor(new Date().getTime() / 1000);
}

var initP2PServer = () => {
    var server = new WebSocket.Server({ port: p2p_port });
    server.on('connection', ws => initConnection(ws));
    console.log('listening for peers on port ' + p2p_port);
};

var initConnection = (ws) => {

    //push the socket
    sockets.push(ws);

    initMessageHandler(ws);
    initErrorHandler(ws);

    //ask for latest block and transactions
    write(ws, queryLatestBlockMsg());
    write(ws, queryAllTransactionsMsg());

    //save all open sockets info to file/db    
    var socketmap = sockets.map(s => '"' + s._socket.remoteAddress.toString() + '"');    
    console.log('saving peers: ' + '[' + socketmap + ']');
    savePeers('[' + socketmap + ']');

};

var initMessageHandler = (ws) => {
    ws.on('message', (data) => {
        var message = JSON.parse(data);
        //console.log('Received message' + JSON.stringify(message));
        switch (message.type) {
            case MessageType.QUERY_LATEST_BLOCK:
                write(ws, responseLatestBlockMsg());
                break;
            case MessageType.QUERY_ALL_BLOCKS:
                write(ws, responseAllBlocksMsg());
                break;
            case MessageType.QUERY_LATEST_TRANSACTION:
                write(ws, responseLatestTransactionsMsg());
                break;
            case MessageType.QUERY_ALL_TRANSACTIONS:
                write(ws, responseAllTransactionsMsg());
                break;
            case MessageType.RESPONSE_BLOCKCHAIN:
                handleBlockchainResponse(message);
                break;
            case MessageType.RESPONSE_TRANSACTION:
                handleTransactionResponse(message);
                break;
        }
    });
};

var initErrorHandler = (ws) => {
    var closeConnection = (ws) => {
        console.log('connection failed to peer: ' + ws.url);
        sockets.splice(sockets.indexOf(ws), 1);

        //attempt to re-connect
        console.log('re-connect to heroku..');
        connectToPeers(['ws://base-crypto.herokuapp.com']);

    };
    ws.on('close', () => closeConnection(ws));
    ws.on('error', () => closeConnection(ws));
};

var generateNextBlock = (transactions, miner_pk, max_time_s) => {
    var t = getTimestamp();
    var previousBlock = getLatestBlock();
    var nextIndex = previousBlock.index + 1;
    var nextTimestamp = getTimestamp();
    //make coinbase tx
    var miner_hash = CryptoJS.SHA256(miner_pk).toString();
    var inputs = [];
    //clone 0-999 transactions
    var transactions_and_coinbase = transactions.slice(0, 1000);
    var total_fees = 0;
    //sum all fees
    transactions_and_coinbase.forEach(function (tx) {
        total_fees = total_fees + calcTransactionFee(blockchain, tx);
    });
    var coinbase_out = (10.0 + total_fees).toFixed(8);
    //add the fees from all transactions to this reward
    var outputs = [new Output(miner_hash, coinbase_out)];
    var secret_keys = [];
    var coinbase_tx = makeTransaction(nextTimestamp, inputs, outputs, secret_keys);
    //inject coinbase tx to front of array
    transactions_and_coinbase.unshift(coinbase_tx);
    //proof of work
    var nonce = 0;
    var nextHash = '';
    var now = getTimestamp();
    var difficulty = [];
    if (blockchain.length > 1) {
        difficulty = getDifficulty(blockchain, blockchain[blockchain.length - 1], blockchain[blockchain.length - 2]);
    }
    else {
        difficulty = [1, 0xf];
    }    
    while (!isValidHashDifficulty(nextHash, difficulty)) {        
        now = getTimestamp();
        if ((now - t) > max_time_s) {
            //ran out of time
            return null;
        }
        nonce = nonce + 1;
        nextHash = calculateHash(nextIndex, previousBlock.hash, nextTimestamp, nonce, transactions_and_coinbase, difficulty[0], difficulty[1]);
    }
    //success - block mined
    console.log(getTimestamp() + ' mined block. nonce/hash = ' + nonce + ' ' + nextHash);
    return new Block(nextIndex, previousBlock.hash, nextTimestamp, transactions_and_coinbase, nonce, nextHash, difficulty[0], difficulty[1]);
};

var isValidHashDifficulty = (hash, difficulty) => {
    //difficulty is a 2-element array (a and b)
    if (hash == '') {
        return false;
    }
    if (hash.indexOf(Array(difficulty[0] + 1).join('0')) != 0) {
        return false;
    }
    //check first digit
    var digit_hex = hash.charAt(difficulty[0]);
    var digit_dec = parseInt(digit_hex, 16);
    if (isNaN(digit_dec)) {
        digit_dec = 15;
    }
    if (digit_dec > difficulty[1]) {
        return false;
    }
    return true;
}

var getDifficulty = (somechain, newblock, previousblock) => {
    //calc the difficulty of the block after newblock 
    var difficulty_a = newblock.difficulty_a;
    var difficulty_b = newblock.difficulty_b;
    var time = newblock.timestamp - previousblock.timestamp;
    if (time < 60 * 10) {
        difficulty_b = difficulty_b - 1;
        if (difficulty_b < 0) {
            difficulty_b = 15;
            difficulty_a = difficulty_a + 1;
        }
    }
    if (time > 60 * 10) {
        difficulty_b = difficulty_b + 1;
        if (difficulty_b > 15) {
            difficulty_b = 0;
            difficulty_a = difficulty_a - 1;
        }
    }
    return [ difficulty_a, difficulty_b ];    
};

var calcTransactionFee = (somechain, transaction) => {
    var amt;
    var fromBlock;
    var tx;
    var fromTransaction;
    var fromOutput;
    var sum_ins = 0;
    var sum_outs = 0;
    //sum all the outputs
    transaction.outputs.forEach(function (output) {
        amt = parseFloat(output.amount);
        sum_outs = sum_outs + amt;
    });
    //sum all inputs   
    var len = transaction.inputs.length;
    var output;
    for (var i = 0; i < len; i++) {
        var input = transaction.inputs[i];
        //find the block
        fromBlock = somechain[input.fromBlockIndex];
        //find the parent tx of this input        
        tx = getTransactionInBlock(fromBlock, input.fromTxHash);

        //find the output in the parent tx, specified by this input
        output = tx.outputs[parseInt(input.fromOutputIndex)];
        sum_ins = sum_ins + parseFloat(output.amount);
        //end for all inputs
    };
    var fee = sum_ins - sum_outs;
    return parseFloat(fee.toFixed(8));
}


var addBlock = (newBlock) => {

    var prev1 = blockchain[blockchain.length - 1];
    var prev2 = null;
    if (blockchain.length > 1) {
        prev2 = blockchain[blockchain.length - 2];
    }

    if (isValidNewBlock(blockchain, newBlock, prev1, prev2)) {
        console.log('addBlock - block is valid.');
        blockchain.push(newBlock);

        //save to local file
        var data = JSON.stringify(blockchain);
        saveChain(data);

        cleanTransactions();
        return true;
    }
    return false;
};

var cleanTransactions = () => {
    console.log('cleanTransactions()');
    var cleaned_transactions = [];
    var len = transactions.length;
    for (var i = 0; i < len; i++) {
        var t = transactions[i];
        if (isValidTransaction(blockchain, t, false)) {
            cleaned_transactions.push(t);
        }
    }
    transactions = cleaned_transactions;
    console.log('cleanTransactions() end');
}

var addTransaction = (newTransaction) => {
    //not used for coinbase
    if (isValidTransaction(blockchain, newTransaction, false)) {
        transactions.push(newTransaction);
    }
    else {
        console.log('ERROR:  could not add transaction - invalid');
    }
};

var isValidNewBlock = (somechain, newBlock, previousBlock, prevBlock2) => {    
    var difficulty =  [1, 0xf];
    if (prevBlock2) {
        difficulty = getDifficulty(somechain, previousBlock, prevBlock2);
    }
    if (previousBlock.index + 1 !== newBlock.index) {
        console.log('invalid index');
        return false;
    } else if (previousBlock.hash !== newBlock.previousHash) {
        console.log('invalid previoushash');
        return false;
    } else if (!isValidHashDifficulty(calculateHashForBlock(newBlock), difficulty)) {
        console.log('invalid hash does not meet difficulty requirements: ' + calculateHashForBlock(newBlock));
        return false;
    } else if (calculateHashForBlock(newBlock) !== newBlock.hash) {
        console.log('invalid hash: ' + calculateHashForBlock(newBlock) + ' newBlock.hash:' + newBlock.hash);
        return false;
    } else if (previousBlock.timestamp >= newBlock.timestamp) {
        console.log('invalid timestamp - must be after prevblock');
        return false;        
    } else if (newBlock.timestamp > getTimestamp()) {
        console.log('invalid timestamp - must be in the past');
        return false;
    }

    //must be array
    if (!Array.isArray(newBlock.data)) {
        console.log('invalid array');
        return false;
    }
    //must be less than 1000 length
    var len = newBlock.data.length;
    if (len > 1000) {
        console.log('block contains > 1000 transactions');
        return false;
    }
    var total_expected_fees = 0;
    //verify all non-coinbase tx's 
    var tx;
    if (len > 1) {
        for (var i = 1; i < len; i++) {
            tx = newBlock.data[i];
            if (!isValidTransaction(somechain, tx, false)) {
                console.log('bad transaction');
                console.log(tx);
                return false;
            }
            //sum all fees
            total_expected_fees = total_expected_fees + calcTransactionFee(somechain, tx);
        }
    }
    //verify coinbase (transaction 0)
    if (!isValidTransaction(somechain, newBlock.data[0], true, total_expected_fees)) {
        console.log('bad coinbase transaction');
        return false;

    }
    return true;
};


var connectToPeers = (newPeers) => {
    newPeers.forEach((peer) => {
        console.log('connecting to peer ' + peer);
        try {
            var ws = new WebSocket(peer);
            ws.on('open', () => {
                //only connect if not already connected
                var bFound = false;
                for (var i = 0; i < sockets.length; i++) {
                    if (sockets[i]._socket.remoteAddress == ws._socket.remoteAddress) {
                        bFound = true;
                    }                
                }                
                if (!bFound) {
                    initConnection(ws);
                    console.log('connected to peer ' + peer);
                }
                else {
                    console.log('already connected to peer ' + peer);
                }
                
            });
            ws.on('error', (err) => {
                console.log('connection failed');
                //console.log(err);
            });
        }
        catch (err) {
            console.log('ERROR: bad peer: ' + peer);
        }

    });
};

var handleBlockchainResponse = (message) => {
    var receivedBlocks = JSON.parse(message.data).sort((b1, b2) => (b1.index - b2.index));
    var latestBlockReceived = receivedBlocks[receivedBlocks.length - 1];
    var latestBlockHeld = getLatestBlock();
    if (latestBlockReceived.index > latestBlockHeld.index) {
        console.log('blockchain possibly behind. We got: ' + latestBlockHeld.index + ' Peer got: ' + latestBlockReceived.index);
        if (latestBlockHeld.hash === latestBlockReceived.previousHash) {
            console.log("We can append the received block to our chain");

            if (addBlock(latestBlockReceived) == true) {
                broadcast(responseLatestBlockMsg());
            }

        } else if (receivedBlocks.length === 1) {
            console.log("We have to query the chain from our peer");
            broadcast(queryAllBlocksMsg());
        } else {
            console.log("Received blockchain is longer than current blockchain");
            replaceChain(receivedBlocks);
        }
    } else {
        console.log('received blockchain is same');
    }
};

//miners
var handleTransactionResponse = (message) => {
    var receivedTransactions = JSON.parse(message.data);
    //verify incoming received uncommited transactions
    receivedTransactions.forEach(function (t) {
        if (!isValidTransaction(blockchain, t, false)) {
            console.log('handleTransactionResponse() received a bad transaction');
            return false;
        }
    });
    //merge and dedupe with local transactions
    //fresh tx's go in here. 'fresh' means we have never seen it before.
    var fresh = [];
    //for each received tx
    var i;
    var j;
    var k;
    var m;
    var lenr = receivedTransactions.length;
    var lent = transactions.length;
    var tx;
    var rtx;
    var tx_in;
    var rtx_in;
    for (i = 0; i < lenr; i++) {
        rtx = receivedTransactions[i];
        //have we already got it?
        //for all floating transactions in our local collection
        var alreadygot = false;
        for (j = 0; j < lent; j++) {
            tx = transactions[j];
            //check if hash matches
            if (tx.hash == rtx.hash) {
                //already got it
                alreadygot = true;
                break;
            }
            //check if inputs match 
            for (k = 0; k < tx.inputs.length; k++) {
                tx_in = tx.inputs[k];
                for (m = 0; m < rtx.inputs.length; m++) {
                    rtx_in = rtx.inputs[m];
                    if ((tx_in.fromBlockIndex == rtx_in.fromBlockIndex) &&
                        (tx_in.fromTxHash == rtx_in.fromTxHash) &&
                        (tx_in.fromOutputIndex == rtx_in.fromOutputIndex)
                    ) {
                        //received tx is trying to double-spend of floating.
                        //let's pretend we have already got it so it isn't added to our local pool.
                        console.log('INFO: Received transaction tried to spend an existing transaction');
                        alreadygot = true;
                        break;
                    }
                }
            }
        }
        if (!alreadygot) {
            fresh.push(rtx);
        }
    }
    //combine tx's with fresh tx's
    var a = transactions.concat(fresh);
    //replace transaction array
    transactions = a;
    //broadcast all fresh (new to me) transactions
    if (fresh.length > 0) {
        broadcast(responseTheseTransactionsMsg(fresh));
    }
};


var replaceChain = (newBlocks) => {
    if ((isValidChain(newBlocks)) && (newBlocks.length > blockchain.length)) {
        console.log('Received blockchain is valid. Replacing current blockchain with received blockchain');
        blockchain = newBlocks;
        var data = JSON.stringify(newBlocks);
        saveChain(data);
        broadcast(responseLatestBlockMsg());
    } else {
        console.log('Received blockchain invalid');
    }
};

var isValidChain = (blockchainToValidate) => {
    //verify genesis block
    if (JSON.stringify(blockchainToValidate[0]) !== JSON.stringify(getGenesisBlock())) {
        return false;
    }
    //verify other blocks
    var tempBlocks = [blockchainToValidate[0]];
    for (var i = 1; i < blockchainToValidate.length; i++) {
        console.log('validating block ' + i + '...');
        var prev1 = tempBlocks[i - 1];    
        var prev2 = null;
        if (tempBlocks.length > 1) {
            prev2 = tempBlocks[i - 2];
        }
        if (isValidNewBlock(blockchainToValidate, blockchainToValidate[i], prev1, prev2)) {
            tempBlocks.push(blockchainToValidate[i]);
        } else {
            return false;
        }
    }
    return true;
};

var getLatestBlock = () => blockchain[blockchain.length - 1];

var isValidTransaction = (somechain, transaction, isCoinbase, total_expected_fees_coinbase) => {

    isCoinbase ? isCoinbase = true : isCoinbase = false;
    var fromBlock;
    var tx;
    var fromTransaction;
    var fromOutput;
    var sum_ins = 0;
    var sum_outs = 0;
    var amt;
    var output;

    //must be array
    if (!Array.isArray(transaction.inputs)) {
        console.log('invalid transaction - inputs must be array');
        return false;
    }
    if (!Array.isArray(transaction.outputs)) {
        console.log('invalid transaction - outputs must be array');
        return false;
    }
    if (!Array.isArray(transaction.signatures)) {
        console.log('invalid transaction - signatures must be array');
        return false;
    }

    //max array sizes
    if (transaction.inputs.length > 256) {
        console.log('invalid transaction - max 256 inputs');
        return false;
    }
    if (transaction.outputs.length > 256) {
        console.log('invalid transaction - max 256 outputs');
        return false;
    }

    if (transaction.inputs.length != transaction.signatures.length) {
        console.log('invalid transaction - inputs and signatures must be 1:1');
        console.log('transaction.outputs.length ' + transaction.outputs.length);
        console.log('transaction.signatures.length ' + transaction.signatures.length);
        return false;
    }

    //sum all the outputs
    transaction.outputs.forEach(function (output) {
        amt = parseFloat(output.amount);
        if (amt > 0) {
            sum_outs = sum_outs + amt;
        }
        else {
            console.log('invalid transaction - output is not positive');
            console.log('value= ' + amt);
            return false;
        }
    });

    //if not coinbase, check all the inputs 
    if (!isCoinbase) {
        //signature index
        var ix = 0;
        //for each input        
        var len = transaction.inputs.length;
        for (var i = 0; i < len; i++) {
            var input = transaction.inputs[i];
            fromBlock = somechain[input.fromBlockIndex];
            //find the parent tx of this input            
            tx = getTransactionInBlock(fromBlock, input.fromTxHash);
            if (!tx) {
                console.log('ERROR: could not find parent tx of input');
                console.log('input.fromTxHash  ' + input.fromTxHash);
                console.log('fromBlock  ' + JSON.stringify(fromBlock));
                console.log('input  ' + JSON.stringify(input));
                return false;
            }
            //find the output in the parent tx, specified by this input
            output = tx.outputs[parseInt(input.fromOutputIndex)];
            sum_ins = sum_ins + parseFloat(output.amount);
            var pk = input.fromPK;
            //make sure hashes match
            var inputFromPKHash = CryptoJS.SHA256(input.fromPK).toString();
            if (output.toHash != inputFromPKHash) {
                console.log('ERROR: input pk does not match referenced pkhash');
                console.log('output.toHash ' + output.toHash);
                console.log('inputFromPKHash  ' + inputFromPKHash);
                return false;
            }
            //compose a 'msg' - the data that was in the signatures
            var msg = {
                timestamp: transaction.timestamp,
                inputs: transaction.inputs,
                outputs: transaction.outputs
            };
            //get transaction hash to be verified 
            var msgHash = CryptoJS.SHA256(JSON.stringify(msg)).toString();
            //verify signature
            var isValid = ecdsa.verify(msgHash, transaction.signatures[ix], pk, 'hex');
            if (!isValid) {
                console.log('WARNING: Invalid signature');
                console.log(msgHash);
                console.log(transaction.signatures[ix]);
                console.log(pk);
                return false;
            }
            if (somechain == blockchain) {
                //check future blocks for a double-spend            
                if (isInputAlreadySpent(somechain, input)) {
                    console.log('WARNING: this input is already spent: ');
                    console.log(JSON.stringify(input));
                    return false;
                }
            }
            else {
                //we are evaluating an incoming chain. 
                //this means this input can legitimately be spent.
                //instead, we check if the peer is trying to smuggle in a
                //double-spent input.
                console.log('checking for double spend..');
                if (isInputAlreadyDoubleSpent(somechain, input)) {
                    console.log('WARNING: this input is double spent! ');
                    console.log(JSON.stringify(input));
                    return false;
                }
                console.log('double spends checked');
            }
            //update signature index
            ix = ix + 1;
            //end for all inputs
        };

        //check that sum of inputs greater than sum of outputs
        //with the difference making the mining fee
        if (sum_ins <= sum_outs) {
            console.log('WARNING: invalid transaction - inputs not greater than outputs');
            return false;
        }
    }

    //validate if coinbase tx
    if (isCoinbase) {
        // expected payout for this block's coinbase
        var expected_payout = 10 + total_expected_fees_coinbase;
        //check payout
        if (sum_outs != expected_payout) {
            console.log('ERROR: invalid coinbase reward - should be ' + expected_payout);
            return false;
        }
        //inputs must be empty array
        if (transaction.inputs.length > 0) {
            console.log('ERROR: coinbase transactions cannot have inputs');
            return false;
        }
    }
    return true;
}

var isInputAlreadySpent = (somechain, input) => {

    var ix = parseInt(input.fromBlockIndex) + 1;
    var len = somechain.length;

    var i;
    var j;
    var k;

    if (ix < len) {
        //for each block
        for (i = ix; i < len; i++) {
            var block = somechain[i];
            var transactions = block.data;
            var len_transactions = transactions.length;
            //for each transaction
            for (j = 0; j < len_transactions; j++) {
                var transaction = transactions[j];
                //for each input
                var len_inputs = transaction.inputs.length;
                for (k = 0; k < len_inputs; k++) {
                    var input2 = transaction.inputs[k];
                    //check if input matches the supplied input
                    if (
                        (input.fromBlockIndex == input2.fromBlockIndex) &&
                        (input.fromTxHash == input2.fromTxHash) &&
                        (input.fromOutputIndex == input2.fromOutputIndex)
                    ) {
                        //already spent
                        console.log('WARNING: input already spent in block ' + i + ' . This is OK within cleanTransactions() ');
                        console.log('WARNING: fromBlockIndex = ' + input2.fromBlockIndex);
                        console.log('WARNING: txHash = ' + input2.fromTxHash);
                        console.log('WARNING: fromOutputIndex = ' + input2.fromOutputIndex);
                        return true;
                    }
                }
            }
        }
    }
    return false;
}

var isInputAlreadyDoubleSpent = (somechain, input) => {
    //treat somechain as suspect - check for double-spent input
    var ix = parseInt(input.fromBlockIndex) + 1;
    var len = somechain.length;
    var i;
    var j;
    var k;
    var spent_tally = 0;
    if (ix < len) {
        //for each block
        for (i = ix; i < len; i++) {
            var block = somechain[i];
            var transactions = block.data;
            var len_transactions = transactions.length;
            //for each transaction
            for (j = 0; j < len_transactions; j++) {
                var transaction = transactions[j];
                //for each input
                var len_inputs = transaction.inputs.length;
                for (k = 0; k < len_inputs; k++) {
                    var input2 = transaction.inputs[k];
                    //check if input matches the supplied input
                    if (
                        (input.fromBlockIndex == input2.fromBlockIndex) &&
                        (input.fromTxHash == input2.fromTxHash) &&
                        (input.fromOutputIndex == input2.fromOutputIndex)
                    ) {
                        //already spent
                        spent_tally = spent_tally + 1;
                    }

                }
            }
        }
        //how many spends? more than 1 is too many 
        if (spent_tally > 1) {
            console.log('ERROR: input DOUBLE-SPENT in block ' + i);
            console.log('ERROR: fromBlockIndex = ' + input2.fromBlockIndex);
            console.log('ERROR: txHash = ' + input2.fromTxHash);
            console.log('ERROR: fromOutputIndex = ' + input2.fromOutputIndex);
            return true;
        }

    }
    return false;
}

var isOutputAlreadySpent = (pkh, fromBlockIndex, txHash, fromOutputIndex) => {
    var ix = parseInt(fromBlockIndex) + 1;
    var len = blockchain.length;
    var i;
    var j;
    var k;
    if (ix < len) {
        //for each block
        for (i = ix; i < len; i++) {
            var block = blockchain[i];
            var transactions = block.data;
            var len_transactions = transactions.length;
            //for each transaction
            for (j = 0; j < len_transactions; j++) {
                var transaction = transactions[j];
                //for each input
                var len_inputs = transaction.inputs.length;
                for (k = 0; k < len_inputs; k++) {
                    var input2 = transaction.inputs[k];
                    //check if input matches the supplied input
                    if (
                        (fromBlockIndex == input2.fromBlockIndex) &&
                        (txHash == input2.fromTxHash) &&
                        (fromOutputIndex == input2.fromOutputIndex)
                    ) {
                        //already spent
                        return true;
                    }
                }
            }
        }
    }
    return false;
}

var getUnspentOutputs = (pk) => {

    var outputs = [];
    var pkh = CryptoJS.SHA256(pk).toString();
    var len = blockchain.length;
    var i;
    var j;
    var k;
    var sum = 0;
    //for each block
    for (i = 0; i < len; i++) {
        var block = blockchain[i];
        var transactions = block.data;
        var len_transactions = transactions.length;
        var transaction;
        //for each transaction
        for (j = 0; j < len_transactions; j++) {
            if (typeof transactions[j] == "object") {
                transaction = transactions[j];
            }
            else {
                transaction = JSON.parse(transactions[j]);
            }
            //for each output
            var len_outputs = transaction.outputs.length;
            for (k = 0; k < len_outputs; k++) {
                var output = transaction.outputs[k];
                //check if output toHash matches suppied pkh
                if (
                    (output.toHash == pkh)
                ) {
                    //found an output that this pkh owns.
                    //is it already spent?
                    if (isOutputAlreadySpent(output.toHash, block.index, transaction.hash, k)) {
                        //yes - ignore it
                    }
                    else {
                        //valid unspent output
                        //push to outputs array with extra info about its origin
                        //augmented output (contains location info to be used by any potential input)
                        outputs.push({
                            "fromBlockIndex": block.index,
                            "fromTxHash": transaction.hash,
                            "fromOutputIndex": k,
                            "fromPK": pk,
                            "toHash": output.toHash,
                            "amount": output.amount
                        });
                    }
                }
            }
        }
    }

    return outputs;
}


var getTransactionInBlock = (fromBlock, txHash) => {
    if (!fromBlock) {
        console.log('ERROR: getTransactionInBlock() had no fromBlock.');
        console.log('txHash = ' + txHash);
        return null;
    }
    var obj = null;
    var data = fromBlock.data;
    var len = data.length;
    for (var i = 0; i < len; i++) {
        var transaction;
        if (typeof data[i] === 'string' || data[i] instanceof String) {            
            transaction = JSON.parse(data[i]);
        }
        else {
            transaction = data[i];
        }        
        if (txHash == transaction.hash) {
            //found transaction
            return (transaction);
        }
    }
    if (!obj) {
        console.log('ERROR: getTransactionInBlock() could not find output.');
        console.log('fromBlock = ' + JSON.stringify(fromBlock));
        console.log('txHash = ' + txHash);
    }
    return obj;
}

//queries

var queryLatestBlockMsg = () => ({
    'type': MessageType.QUERY_LATEST_BLOCK
});

var queryAllBlocksMsg = () => ({
    'type': MessageType.QUERY_ALL_BLOCKS
});

var queryLatestTransactionMsg = () => ({
    'type': MessageType.QUERY_LATEST_TRANSACTION
});

var queryAllTransactionsMsg = () => ({
    'type': MessageType.QUERY_ALL_TRANSACTIONS
});

//responses

var responseAllBlocksMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify(blockchain)
});

var responseLatestBlockMsg = () => ({
    'type': MessageType.RESPONSE_BLOCKCHAIN,
    'data': JSON.stringify([getLatestBlock()])
});

var responseAllTransactionsMsg = () => ({
    'type': MessageType.RESPONSE_TRANSACTION,
    'data': JSON.stringify(transactions)
});

var responseTheseTransactionsMsg = (txs) => ({
    'type': MessageType.RESPONSE_TRANSACTION,
    'data': JSON.stringify(txs)
});

var responseLatestTransactionMsg = (transaction) => ({
    'type': MessageType.RESPONSE_TRANSACTION,
    'data': JSON.stringify([transaction])
});


var write = (ws, message) => {
    ws.send(JSON.stringify(message));
}

var broadcast = (message) => {
    sockets.forEach(socket => write(socket, message));
}

getVersion();

initHttpServer();

initP2PServer();
