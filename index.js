const arcsecond = require('arcsecond');
const arcsecondBinary = require('arcsecond-binary');
const fs = require('fs');
const path = require('path');

const file = fs.readFileSync(path.join(__dirname, './jj.wav'));

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
    const subChunk1Size = yield arcsecondBinary.u32LE;
    const audioFormat = yield arcsecondBinary.u16LE;
    const numChannels = yield arcsecondBinary.u16LE;
    const sampleRate = yield arcsecondBinary.u32LE;
    const byteRate = yield arcsecondBinary.u32LE;
    const blockAlign = yield arcsecondBinary.u16LE;
    const bitsPerSample = yield arcsecondBinary.u16LE;
    const extensionSize = subChunk1Size > 16 ?
        yield arcsecondBinary.u16LE :
        0;

    /// WAVE_FORMAT_EXTENSIBLE ///

    const validBitsPerSample = audioFormat === 65534 ?
        yield arcsecondBinary.u16LE :
        undefined;
    const channelMask = audioFormat === 65534 ?
        yield arcsecondBinary.u32LE :
        undefined;
    // subFormat is 16 byte GUID, can't figure out a way to parse it in JS yet
    const subFormat = audioFormat === 65534 ?
        yield arcsecondBinary.u32LE :
        undefined;

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
        subChunk1Size,
        audioFormat,
        numChannels,
        sampleRate,
        byteRate,
        blockAlign,
        bitsPerSample,
        extensionSize,

        validBitsPerSample,
        channelMask,
        subFormat
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

        return {
            id,
            size,
            sampleFrames,
        };
    }
});

const dataSubChunk = arcsecond.coroutine(function* () {
    const id = yield arcsecond.str('data');
    const size = yield arcsecondBinary.u32LE;

    const fmtData = yield arcsecond.getData;

    const samples = size / fmtData.numChannels / (fmtData.bitsPerSample / 8);
    const channelData = Array.from({ length: fmtData.numChannels }, () => []);

    let sampleParser;
    if (fmtData.bitsPerSample === 8) {
        sampleParser = arcsecondBinary.s8;
    } else if (fmtData.bitsPerSample === 16) {
        sampleParser = arcsecondBinary.s16LE;
    } else if (fmtData.bitsPerSample === 32) {
        sampleParser = arcsecondBinary.s32LE;
    } else {
        yield arcsecond.fail(`Unsupported bits per sample: ${fmtData.bitsPerSample}`);
    }

    for (let sampleIndex = 0; sampleIndex < samples; sampleIndex++) {
        for (let i = 0; i < fmtData.numChannels; i++) {
            const sampleValue = yield sampleParser;
            channelData[i].push(sampleValue);
        }
    }

    return {
        id,
        size,
        channelData
    };
});

const parser = arcsecond.sequenceOf([
    riffChunk,
    fmtSubChunk,
    factSubChunk,
    dataSubChunk,
]).map(([riffChunk, fmtSubChunk, factSubChunk, dataSubChunk]) => ({
    riffChunk,
    fmtSubChunk,
    factSubChunk,
    dataSubChunk
}));

const output = parser.run(file.buffer);
if (output.isError) {
    throw new Error(output.error);
}