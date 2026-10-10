import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createTranscriber,validateAudio} from '../backend/modules/ai/transcription.js';
import {encodeWav,mountDictation} from '../frontend/modules/dictation.js';

function audioBuffer({rate=16000,seconds=.25,channels=1}={}) {
  const values=Array.from({length:channels},()=>Float32Array.from({length:Math.floor(rate*seconds)},()=>.2));
  return {sampleRate:rate,length:values[0].length,numberOfChannels:channels,getChannelData:index=>values[index]};
}
const payload=()=>({mime:'audio/wav',language:'ru',data:Buffer.from(encodeWav(audioBuffer())).toString('base64')});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('browser PCM encoder produces bounded mono WAV and server rejects other containers, formats and durations',()=>{
  const wav=encodeWav(audioBuffer({rate:48000,channels:2,seconds:1}));
  assert.equal(validateAudio({mime:'audio/wav',data:Buffer.from(wav).toString('base64')}).length,32044);
  const broken=Buffer.from(wav);broken.writeUInt32LE(48000,24);
  assert.throws(()=>validateAudio({mime:'audio/wav',data:broken.toString('base64')}),/16 кГц/);
  assert.throws(()=>validateAudio({...payload(),mime:'audio/webm'}),/WAV/);
  assert.throws(()=>validateAudio({...payload(),data:'x'.repeat(2_700_004)}),/WAV/);
  assert.throws(()=>validateAudio({mime:'audio/wav',data:Buffer.from(encodeWav(audioBuffer({seconds:.01}))).toString('base64')}),/60 секунд/);
});

async function fixture(t,code) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'dictation-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const command=path.join(directory,'whisper-fixture'),model=path.join(directory,'fixture-model.bin');
  await writeFile(model,'fixture',{mode:0o600});await writeFile(command,'#!'+process.execPath+'\n'+code);await chmod(command,0o700);
  return {command,model,directory};
}

test('native transcription enforces one job and deletes private audio after completion',async t=>{
  const options=await fixture(t,`const fs=require('node:fs');const args=process.argv.slice(2);const input=args[args.indexOf('--file')+1],output=args[args.indexOf('--output-file')+1];if((fs.statSync(input).mode&511)!==384)process.exit(2);setTimeout(()=>fs.writeFileSync(output+'.txt','Исправь заголовок'),50);`);
  const transcriber=createTranscriber({...options,temporaryDir:options.directory});t.after(()=>transcriber.close());
  assert.equal((await transcriber.status()).available,true);
  const first=transcriber.transcribe(payload());
  await assert.rejects(()=>transcriber.transcribe(payload()),error=>error.status===429);
  assert.deepEqual(await first,{text:'Исправь заголовок'});
  assert.equal((await readdir(options.directory)).some(name=>name.startsWith('presentation-voice-')),false);
});

test('native timeout and aborted recordings also clean up temporary files',async t=>{
  const options=await fixture(t,'setTimeout(()=>{},5000);'),transcriber=createTranscriber({...options,temporaryDir:options.directory,timeoutMs:30});t.after(()=>transcriber.close());
  await assert.rejects(()=>transcriber.transcribe(payload()),error=>error.status===504);
  const controller=new AbortController();controller.abort();await assert.rejects(()=>transcriber.transcribe(payload(),{signal:controller.signal}),/abort/i);
  assert.equal((await readdir(options.directory)).some(name=>name.startsWith('presentation-voice-')),false);
});

class Button extends EventTarget {constructor(){super();this.dataset={};this.attributes={};}setAttribute(key,value){this.attributes[key]=value;}click(){this.dispatchEvent(new Event('click'));}}
function composer(value='Сделай') {return {value,selectionStart:value.length,selectionEnd:value.length,events:0,setRangeText(text,start,end){this.value=this.value.slice(0,start)+text+this.value.slice(end);this.selectionStart=this.selectionEnd=start+text.length;},dispatchEvent(){this.events++;},focus(){}};}

test('speech dictation inserts Russian final text once and leaves sending to the user',async()=>{
  let recognition;class Speech {constructor(){recognition=this;}start(){}stop(){this.onend();}abort(){}}
  const button=new Button(),input=composer(),status={dataset:{}},requests=[];
  const mounted=mountDictation({button,input,status,environment:{SpeechRecognition:Speech},fetchImpl:async url=>{requests.push(url);return {ok:true,json:async()=>({available:false})};}});
  await mounted.ready;button.click();await tick();assert.equal(recognition.lang,'ru-RU');assert.equal(mounted.state,'recording');
  const result=[{transcript:'заголовок короче'}];result.isFinal=true;const event={resultIndex:0,results:[result]};recognition.onresult(event);recognition.onresult(event);
  assert.equal(input.value,'Сделай');await mounted.stop();
  assert.equal(input.value,'Сделай заголовок короче');assert.equal(input.events,1);assert.equal(mounted.state,'idle');assert.deepEqual(requests,['/api/transcription/status']);mounted.destroy();
});

test('unsupported speech browser records audio and uses the keyless server fallback',async()=>{
  let trackStopped=false,posted;class Recorder {static isTypeSupported(){return true;}constructor(){this.mimeType='audio/webm';this.state='inactive';}start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable({data:new Blob(['fixture audio'])});this.onstop();});}}
  class Context {async decodeAudioData(){return audioBuffer({seconds:1});}async close(){}}
  const button=new Button(),input=composer(''),status={dataset:{}},mounted=mountDictation({button,input,status,environment:{MediaRecorder:Recorder,AudioContext:Context,navigator:{mediaDevices:{getUserMedia:async()=>({getTracks:()=>[{stop(){trackStopped=true;}}]})}}},fetchImpl:async(url,options)=>{
    if(url.endsWith('/status'))return {ok:true,json:async()=>({available:true})};posted=JSON.parse(options.body);validateAudio(posted);return {ok:true,json:async()=>({text:'Добавь второй слайд'})};
  }});
  await mounted.ready;button.click();await tick();assert.equal(mounted.state,'recording');await mounted.stop();
  assert.equal(input.value,'Добавь второй слайд');assert.equal(posted.language,'ru');assert.equal(trackStopped,true);mounted.destroy();
});

test('unavailable speech services show an error without changing the composer',async()=>{
  const button=new Button(),input=composer(),status={dataset:{}},errors=[];
  const mounted=mountDictation({button,input,status,onError:error=>errors.push(error.message),environment:{},fetchImpl:async()=>({ok:true,json:async()=>({available:false})})});await mounted.ready;button.click();await tick();
  assert.equal(mounted.state,'error');assert.match(errors[0],/недоступно/);assert.equal(input.value,'Сделай');mounted.destroy();
});

test('denied microphone access reports permission error and never starts recording',async()=>{
  const button=new Button(),input=composer(),status={dataset:{}},errors=[];
  class Recorder {constructor(){throw new Error('Recorder must not start');}}
  const mounted=mountDictation({button,input,status,onError:error=>errors.push(error.message),environment:{MediaRecorder:Recorder,navigator:{mediaDevices:{getUserMedia:async()=>{throw Object.assign(new Error('denied'),{name:'NotAllowedError'});}}}},fetchImpl:async()=>({ok:true,json:async()=>({available:true})})});
  await mounted.ready;button.click();await tick();
  assert.equal(mounted.state,'error');assert.match(errors[0],/Разрешите доступ/);assert.equal(input.value,'Сделай');mounted.destroy();
});

test('stopping while the microphone permission dialog is open releases late capture without recording',async()=>{
  let grant,trackStopped=false,recorderCreated=false;
  class Recorder {constructor(){recorderCreated=true;}}
  const button=new Button(),input=composer(),status={dataset:{}},mounted=mountDictation({button,input,status,onError:()=>{},environment:{MediaRecorder:Recorder,navigator:{mediaDevices:{getUserMedia:()=>new Promise(resolve=>{grant=resolve;})}}},fetchImpl:async()=>({ok:true,json:async()=>({available:true})})});
  await mounted.ready;button.click();await tick();await mounted.stop();
  grant({getTracks:()=>[{stop(){trackStopped=true;}}]});await tick();
  assert.equal(recorderCreated,false);assert.equal(trackStopped,true);assert.equal(input.value,'Сделай');mounted.destroy();
});
