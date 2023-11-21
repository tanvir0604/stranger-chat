const express = require('express')
const app = express()
const http = require('http')
const server = http.createServer(app)
const {Server} = require('socket.io')
const io = new Server(server)
const geoip = require('geoip-country')
const { MongoClient, ServerApiVersion } = require('mongodb')


// mongodb connection
const uri = 'mongodb://localhost:27017';
const client = new MongoClient(uri,  {
        serverApi: {
            version: ServerApiVersion.v1,
            strict: true,
            deprecationErrors: true,
        }
    }
);

let clientCollection = null;
async function run() {
    try {
        await client.connect();
        const database = client.db('stranger');
        clientCollection = database.collection('clients');
        await clientCollection.deleteMany({});
        countOnlineUsers();
        console.log('mongo connection established');
    } catch (error) {
        // Ensures that the client will close when you finish/error
        console.log('closing mongo connection');
        await client.close();
    }
}

run().catch(console.dir);

async function countOnlineUsers(){
    const count = await clientCollection.countDocuments();
    io.emit('user-count', count);
    setTimeout(countOnlineUsers, 5000);
}
async function insertDoc(socket, doc){
    const result = await clientCollection.insertOne(doc);
    socket.dbId = result.insertedId;
}

async function updateDoc(socket, doc){
    const result = await clientCollection.updateOne({ _id: socket.dbId }, { $set: doc });
    // console.log(result);
}
async function deleteDoc(where){
    await clientCollection.deleteMany(where);
}

async function findMatch(socket){
    if(!socket.available || !waitingMatch[socket.id]) return false;

    console.log('waiting list')
    console.log(Object.keys(waitingMatch).length)

    socket.emit('notification', 'Searching for suitable match!');
    const result = await clientCollection.findOne({gender: socket.genderPreference, genderPreference: socket.gender, available: true});
    if(result){
        if(socket.available && waitingMatch[result.socket] && waitingMatch[result.socket].available){
            socket.partner = result.socket;
            socket.available = false;
            waitingMatch[result.socket].partner = socket.id;
            waitingMatch[result.socket].available = false;

            socket.emit('notification', 'Found a match from '+result.country);
            socket.emit('process', {type: 1, partner: socket.partner})
            socket.emit('message', {msg: 'A partner joined, lets start chatting!!', gender: waitingMatch[result.socket].gender})

            waitingMatch[result.socket].emit('notification', 'Found a match from '+waitingMatch[result.socket].country);
            waitingMatch[result.socket].emit('process', {type: 1, partner: waitingMatch[result.socket].partner})
            waitingMatch[result.socket].emit('message', {msg: 'A partner joined, lets start chatting!!', gender: socket.gender})

            updateDoc(socket, {available: false});
            updateDoc(waitingMatch[result.socket], {available: false});

            delete waitingMatch[socket.id]
            delete waitingMatch[result.socket]



            return true;
        }
    }


    socket.emit('notification', 'No match found, trying again!');
    setTimeout(() => {
        findMatch(socket);
    }, 5000);


    // console.log(result);
}

let waitingMatch = new Object();

io.on('connection', (socket) => {
    let ip = socket.handshake.address;
    let geo = geoip.lookup(ip);
    let country = 'US';
    if(geo && geo.country){
        country = geo.country;
    }
    socket.country = country;

    insertDoc(socket, {socket: socket.id, gender: 1, genderPreference: 2, country: country, available: false}).catch(console.dir);

    socket.on('process', (msg) => {
        switch (msg.type){
            case 1:
                // start matching
                socket.gender = msg.gender;
                socket.genderPreference = msg.genderPreference;
                socket.available = true;
                waitingMatch[socket.id] = socket;
                updateDoc(socket, {gender: Number(msg.gender), genderPreference: Number(msg.genderPreference), available: true});
                findMatch(socket);
                break;
            case 2:
                // stop matching
                updateDoc(socket, {available: false});
                delete waitingMatch[socket.id]
                socket.emit('process', {type: 2});
                socket.emit('notification', 'Chatting stopped!');
                if(socket.partner){
                    console.log('socket partner found, now processing partner');
                    socket.to(socket.partner).emit('notification', 'Chatting stopped by partner!');
                    socket.to(socket.partner).emit('process', {type: 2});
                }
                break;
        }
    })

    socket.on('message', (msg) => {
        socket.to(socket.partner).emit('message', msg);
    });

    socket.on('disconnect', () => {
        deleteDoc({ _id: socket.dbId });
        delete waitingMatch[socket.id]
        if(socket.partner){
            console.log('socket partner found, now processing partner');
            socket.to(socket.partner).emit('process', {type: 2});
            socket.to(socket.partner).emit('notification', 'Partner disconnected!');
        }
    })
});

server.listen(3000, () => {
    console.log('listening on : 3000');
});

app.use(express.static('public'));
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});