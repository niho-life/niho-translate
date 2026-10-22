import { describe,expect,it } from "vitest";
import {
  AUDIO_BATCH_BYTES,
  ProtocolValidationError,
  validateClientEvent,
  validateServerEvent,
} from "../packages/protocol/src/index.ts";

const audio=Buffer.alloc(AUDIO_BATCH_BYTES).toString("base64");
describe("protocol validation",()=>{
  it("accepts only aligned bounded PCM and exact JSON schema",()=>{
    expect(validateClientEvent(JSON.stringify({v:1,type:"audio.append",audio,atMs:1})).type).toBe("audio.append");
    expect(()=>validateClientEvent(JSON.stringify({v:1,type:"audio.append",audio:Buffer.alloc(2).toString("base64"),atMs:1}))).toThrow(ProtocolValidationError);
    expect(()=>validateClientEvent(JSON.stringify({v:1,type:"client.ready",extra:true}))).toThrow(/unknown_extra/);
    expect(validateClientEvent(JSON.stringify({v:1,type:"room.start"})).type).toBe("room.start");
    expect(validateClientEvent(JSON.stringify({v:1,type:"client.ack",deliveryId:3}))).toMatchObject({deliveryId:3});
    expect(()=>validateClientEvent(JSON.stringify({v:1,type:"client.ack",deliveryId:0}))).toThrow(/deliveryId/);
  });
  it("validates server events",()=>{
    expect(validateServerEvent({v:1,type:"latency.status",deliveryId:1,status:"unknown"})).toEqual({v:1,type:"latency.status",deliveryId:1,status:"unknown"});
    expect(()=>validateServerEvent({v:1,type:"caption.delta",deliveryId:1,speakerId:"p",generation:1,language:"fr",delta:"x",atMs:0})).toThrow();
    expect(validateServerEvent({v:1,type:"caption.delta",deliveryId:1,speakerId:"p",generation:1,language:"en",captionOnly:false,delta:"x",atMs:0}).type).toBe("caption.delta");
    expect(()=>validateServerEvent({v:1,type:"caption.delta",deliveryId:1,speakerId:"p",generation:1,language:"en",delta:"x",atMs:0})).toThrow(/captionOnly/);
    expect(validateServerEvent({v:1,type:"session.identity",deliveryId:1,participantId:"p",generation:2}).type).toBe("session.identity");
    expect(validateServerEvent({v:1,type:"audio",deliveryId:1,speakerId:"p",generation:1,language:"en",audio:Buffer.alloc(2).toString("base64")}).type).toBe("audio");
    expect(validateServerEvent({v:1,type:"error",code:"UNAUTHORIZED",fatal:true})).toMatchObject({code:"UNAUTHORIZED"});
    expect(()=>validateServerEvent({v:1,type:"route",canCapture:false,reason:"blocked"})).toThrow(/deliveryId/);
  });
});
