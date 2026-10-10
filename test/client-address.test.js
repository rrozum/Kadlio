import test from 'node:test';
import assert from 'node:assert/strict';
import {clientAddress} from '../backend/http/client-address.js';

test('rate limits ignore spoofed headers unless the nearest local proxy is explicitly trusted',()=>{
  const req=(peer,forwarded)=>({socket:{remoteAddress:peer},headers:{'x-forwarded-for':forwarded}});
  assert.equal(clientAddress(req('127.0.0.1','203.0.113.20')),'127.0.0.1');
  assert.equal(clientAddress(req('198.51.100.1','203.0.113.20'),{trustProxy:'loopback'}),'198.51.100.1');
  assert.equal(clientAddress(req('127.0.0.1','203.0.113.20, 198.51.100.1'),{trustProxy:'loopback'}),'198.51.100.1');
  assert.equal(clientAddress(req('::1','203.0.113.99, 198.51.100.1'),{trustProxy:'loopback'}),'198.51.100.1');
  assert.equal(clientAddress(req('127.0.0.1','fake'),{trustProxy:'loopback'}),'127.0.0.1');
  assert.equal(clientAddress(req('127.0.0.1','203.0.113.20, fake'),{trustProxy:'loopback'}),'127.0.0.1');
});
