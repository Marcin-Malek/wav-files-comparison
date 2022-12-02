const arcsecond = require('arcsecond');
const arcsecondBinary = require('arcsecond-binary');
const fs = require('fs');
const path = require('path');

const getSamplesData = (fileName) => {

    const file = fs.readFileSync(path.join(__dirname, fileName));

    const riffChunkSize = arcsecondBinary.u32LE.chain(size => {
        if (size !== file.length - 8) {
            return arcsecond.fail(`Invalid file size: ${file.length}. Expected ${size}`);
        }
        return arcsecond.succeedWith(size);
    });

    const riffChunk = arcsecond.sequenceOf([
        arcsecond.str('RIFF'),
        riffChunkSize,
        arcsecond.str('WAVE')
    ]);

    const fmtSubChunk = arcsecond.coroutine(function* () {
        const id = yield arcsecond.str('fmt ');
        const fmtChunkSize = yield arcsecondBinary.u32LE;
        const audioFormat = yield arcsecondBinary.u16LE;
        const numChannels = yield arcsecondBinary.u16LE;
        const sampleRate = yield arcsecondBinary.u32LE;
        const byteRate = yield arcsecondBinary.u32LE;
        const blockAlign = yield arcsecondBinary.u16LE;
        const bitsPerSample = yield arcsecondBinary.u16LE;
        const extensionSize = fmtChunkSize > 16 ?
            yield arcsecondBinary.u16LE :
            0;

        /// WAVE_FORMAT_EXTENSIBLE ///
        if (audioFormat === 65534) {
            return arcsecond.fail(`Unsupported audio format - WAVE_FORMAT_EXTENSIBLE`);
        }
        /* const validBitsPerSample = audioFormat === 65534 ?
            yield arcsecondBinary.u16LE :
            undefined;
        const channelMask = audioFormat === 65534 ?
            yield arcsecondBinary.u32LE :
            undefined;
        // subFormat is 16 byte GUID, can't figure out a way to parse it in JS yet
        const subFormat = audioFormat === 65534 ?
            yield arcsecondBinary.u32LE :
            undefined; */

        const expectedByteRate = sampleRate * numChannels * bitsPerSample / 8;
        if (byteRate !== expectedByteRate) {
            yield arcsecond.fail(`Invalid byte rate: ${byteRate}, expected ${expectedByteRate}`);
        }

        const expectedBlockAlign = numChannels * bitsPerSample / 8;
        if (blockAlign !== expectedBlockAlign) {
            yield arcsecond.fail(`Invalid block align: ${blockAlign}, expected ${expectedBlockAlign}`);
        }

        const fmtChunkData = {
            id,
            fmtChunkSize,
            audioFormat,
            numChannels,
            sampleRate,
            byteRate,
            blockAlign,
            bitsPerSample,
            extensionSize,

            /* validBitsPerSample,
            channelMask,
            subFormat */
        };

        yield arcsecond.setData(fmtChunkData);
        return fmtChunkData;
    });

    const factSubChunk = arcsecond.coroutine(function* () {
        const fmtData = yield arcsecond.getData;
        if (fmtData.audioFormat === 1) {
            // Pulse code modulation
        } else {
            // Non-pulse code modulation
            const id = yield arcsecond.str('fact');
            const size = yield arcsecondBinary.u32LE;
            const sampleFrames = yield arcsecondBinary.u32LE;

            const factChunkData = {
                id,
                size,
                sampleFrames,
            }
            yield arcsecond.setData(fmtData, factChunkData);
            return factChunkData;
        }
    });

    const dataSubChunk = arcsecond.coroutine(function* () {
        const id = yield arcsecond.str('data');
        const soundDataSize = yield arcsecondBinary.u32LE;
        const previousChunksData = yield arcsecond.getData;

        const sampleFrames = previousChunksData && previousChunksData.sampleFrames ||
            soundDataSize / previousChunksData.numChannels / (previousChunksData.bitsPerSample / 8);
        const channelData = Array.from({ length: previousChunksData.numChannels }, () => []);

        let sampleParser;
        if (previousChunksData.bitsPerSample === 8) {
            sampleParser = arcsecondBinary.s8;
        } else if (previousChunksData.bitsPerSample === 16) {
            sampleParser = arcsecondBinary.s16LE;
        } else if (previousChunksData.bitsPerSample === 32) {
            sampleParser = arcsecondBinary.s32LE;
        } else {
            yield arcsecond.fail(`Unsupported bit depth: ${previousChunksData.bitsPerSample}`);
        }

        for (let sampleIndex = 0; sampleIndex < sampleFrames; sampleIndex++) {
            for (let i = 0; i < previousChunksData.numChannels; i++) {
                const sampleValue = yield sampleParser;
                channelData[i].push(sampleValue);
            }
        }
        yield arcsecond.setData(sampleFrames);
        return {
            id,
            soundDataSize,
            channelData,
        };
    });

    const parser = arcsecond.sequenceOf([
        riffChunk,
        fmtSubChunk,
        factSubChunk,
        dataSubChunk,
        arcsecond.getData,
    ]).map(([riffChunk, fmtSubChunk, factSubChunk, dataSubChunk, sampleFrames]) => ({
        riffChunk,
        fmtSubChunk,
        factSubChunk,
        dataSubChunk,
        sampleFrames
    }));

    const parsingOutput = parser.run(file.buffer);
    if (parsingOutput.isError) {
        throw new Error(parsingOutput.error);
    }

    return parsingOutput.result;
}

const firstTrack = getSamplesData("jj.wav");
const secondTrack = getSamplesData("test_two.wav");

console.log(
    "firstTrack:", firstTrack,
    "secondTrack:", secondTrack
);

if (firstTrack.fmtSubChunk.audioFormat !== secondTrack.fmtSubChunk.audioFormat) {
    return console.error(`
    These files are incomparable due to different data formatting: 
    Track#1 Format code: ${firstTrack.fmtSubChunk.audioFormat}
    Track#2 Format code: ${secondTrack.fmtSubChunk.audioFormat}`
    );
} else if (firstTrack.fmtSubChunk.numChannels !== secondTrack.fmtSubChunk.numChannels) {
    return console.error(`
    Cannot compare file containing ${firstTrack.fmtSubChunk.numChannels} channels with file containing ${secondTrack.fmtSubChunk.numChannels} channels`
    );
} else if (firstTrack.fmtSubChunk.sampleRate !== secondTrack.fmtSubChunk.sampleRate) {
    return console.error(`Incompatible sampling rates. Got ${firstTrack.fmtSubChunk.sampleRate} and ${secondTrack.fmtSubChunk.sampleRate}`);
} else if (firstTrack.fmtSubChunk.bitsPerSample !== secondTrack.fmtSubChunk.bitsPerSample) {
    return console.error(`Incompatible bit depths. Got ${firstTrack.fmtSubChunk.bitsPerSample} and ${secondTrack.fmtSubChunk.bitsPerSample}`);
}

const firstTrackLength = new Date(firstTrack.sampleFrames / firstTrack.fmtSubChunk.sampleRate * 1000);
const secondTrackLength = new Date(secondTrack.sampleFrames / secondTrack.fmtSubChunk.sampleRate * 1000);

if (firstTrack.sampleFrames / firstTrack.fmtSubChunk.sampleRate !== secondTrack.sampleFrames / secondTrack.fmtSubChunk.sampleRate) {
    console.log("Track lengths are different");
}

console.log(`
    Track#1 Length: ${firstTrackLength.toISOString().slice(14, -1)}
    Track#2 Length: ${secondTrackLength.toISOString().slice(14, -1)}
`);

const differentSamplesIndexes = firstTrack.dataSubChunk.channelData.map((element, index) => element.reduce(
    (differentSamples, currentSample, currentIndex) => {
        const differentSampleIndex = secondTrack.dataSubChunk.channelData[index].findIndex(
            (sample, sampleIndex) => (sampleIndex === currentIndex) && (currentSample !== sample));
        differentSampleIndex !== -1 && differentSamples.push(differentSampleIndex);
        return differentSamples;
    }, []));

const differenceBegin = new Date(Math.min(...differentSamplesIndexes.flat()) / firstTrack.fmtSubChunk.sampleRate * 1000);
const differenceEnd = new Date(Math.max(...differentSamplesIndexes.flat()) / firstTrack.fmtSubChunk.sampleRate * 1000);

console.log(`Tracks are different during ${differenceBegin.toISOString().slice(14, -1)} - ${differenceEnd.toISOString().slice(14, -1)}`);