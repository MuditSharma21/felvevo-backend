const express = require('express') 
const app = express()
const fs = require('fs')
const cors = require('cors')
const http = require('http')
const dotenv = require('dotenv')
const { Server } = require('socket.io')
const { Readable } = require('stream')
const axios = require('axios')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const { OpenAI } = require('openai')


dotenv.config()

const openai = new OpenAI({
    apiKey: process.env.OPENAI_KEY
})

const s3 = new S3Client({
    credentials: {
        accessKeyId: process.env.ACCESS_KEY_ID,
        secretAccessKey: process.env.SECRET_ACCESS_KEY
    },
    region: process.env.BUCKET_REGION
})

const server = http.createServer(app)
app.use(cors())

const io = new Server(server, {
    cors: {
        origin: process.env.ELECTRON_HOST,
        methods: ['GET', 'POST']
    }
})

let recorderChunks = []

io.on('connection', (socket) => {
    console.log('✅ Socket Connected');
    socket.on('video-chunks', async (data) => {
        console.log('✅ Video Chunk sent', data)
        const writeStream = fs.createWriteStream('temp_upload/' + data.filename)
        recorderChunks.push(data.chunks)
        const videoBlob = new Blob(recorderChunks, {
            type: 'video/webm; codecs=vp9'
        })
        const buffer = Buffer.from(await videoBlob.arrayBuffer())
        const readStream = Readable.from(buffer)
        readStream.pipe(writeStream).on('finish', () => {
            console.log('✅ Chunk saved', data);
            
        })
    })
    socket.on('process-video', async (data) => {
        console.log('✅ Processing Video...', data)
        recorderChunks = []
        fs.readFile('temp_upload/' + data.filename, async (err, file) => {
            const processing = await axios.post(`${process.env.NEXT_API_HOST}/recording/${data.userId}/processing`, {
                filename: data.filename
            })
            if (processing.data.status !== 200) return console.log('🔴Error: Something went wrong with creating the processing file')
            const Key = data.filename
            const Bucket = process.env.BUCKET_NAME
            const ContentType = 'video/webm'
            const command = new PutObjectCommand({
                Key, Bucket, ContentType, Body: file
            })
            const fileStatus = await s3.send(command)

            //Transcription
            if (fileStatus['$metadata'].httpStatusCode === 200) {
                console.log('✅ Video uploaded to aws');
               if (processing.data.plan === 'PREMIUM') {
                    fs.stat('temp_upload' + data.filename, async (err, stat) => {
                        if (!err) {
                            if (stat.size < 25000000) {
                                const transcription = await openai.audio.transcriptions.create({
                                    file: fs.createReadStream(`temp_upload/${data.filename}`),
                                    model: 'whisper-1',
                                    response_format: 'text'
                                })
                                if (transcription) {
                                    const completion = await openai.chat.completions.create({
                                        model: 'gpt-4o-mini',
                                        response_format: { type: 'json_object' },
                                        messages: [{
                                            role: 'system',
                                            content: `You are going to generate a title and a nice description using the speech to text transcription provided: transcription(${transcription}) and then return it in json format as {"title": <the title you gave>, "summary": <the summary you created>}`
                                        }]
                                    })
                                    const titleAndSummaryGenerated = await axios.post(`${process.env.NEXT_API_HOST}/recording/${data.userId}/transcribe`, {
                                        filename: data.filename,
                                        content: completion.choices[0].message.content,
                                        transcript: transcription
                                    })
                                    if (titleAndSummaryGenerated.data.status !== 200) {
                                        console.log('🔴Error: Something went wrong while creating the title and descripiton')
                                    }
                                }
                            }
                        }
                    })
                }
                const stopProcessing = await axios.post(`${process.env.NEXT_API_HOST}/recording/${data.userId}/complete`, {
                    filename: data.filename
                })
                if (stopProcessing.data.status !== 200) {
                    console.log('🔴Error: Something went wrong during the completion process')
                }
                if (stopProcessing.status === 200) {
                    fs.unlink('temp_upload' + data.filename, (err) => {
                        if (!err) {
                            console.log(data.filename + ' ' + '✅Deleted Successfully')                            
                        }
                    })
                }
            } else {
                console.log('🔴Error: Upload Failed! Process Aborted!')
            }
        })
    })
    socket.on('disconnect', async () => {
        console.log('🔴 Socket.id diconnected', socket.id)
    })
})

const port = process.env.PORT || 5000; // If the PORT environment variable is set, use that, otherwise default to 5000.

server.listen(port, () => {
    console.log(`✅ Listening on port ${port}`);
});
