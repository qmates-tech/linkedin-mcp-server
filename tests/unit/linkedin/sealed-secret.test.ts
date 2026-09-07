import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { seal, unseal } from '../../../src/linkedin/sealed-secret.js';

const KEY = randomBytes(32);
const A_QMATE = '106977126509011341120';
const ANOTHER_QMATE = '999888777666555444333';
const A_LINKEDIN_TOKEN = 'AQV8...un-token-linkedin';

describe('un token sigillato', () => {
  it('torna leggibile solo con la stessa chiave e lo stesso QMate', () => {
    const sealed = seal(KEY, A_LINKEDIN_TOKEN, A_QMATE);
    expect(unseal(KEY, sealed, A_QMATE)).toBe(A_LINKEDIN_TOKEN);
  });

  it('non contiene il token in chiaro', () => {
    expect(seal(KEY, A_LINKEDIN_TOKEN, A_QMATE).toString('binary')).not.toContain(A_LINKEDIN_TOKEN);
  });

  it('è diverso a ogni sigillo, così due QMate con lo stesso token non si riconoscono', () => {
    // Un nonce riusato renderebbe il database una tabella di uguaglianze.
    const primo = seal(KEY, A_LINKEDIN_TOKEN, A_QMATE);
    const secondo = seal(KEY, A_LINKEDIN_TOKEN, A_QMATE);
    expect(primo.equals(secondo)).toBe(false);
  });
});

describe('ogni fallimento rende null, non solleva', () => {
  it('con la chiave sbagliata — il caso che accadrà davvero', () => {
    expect(unseal(randomBytes(32), seal(KEY, A_LINKEDIN_TOKEN, A_QMATE), A_QMATE)).toBeNull();
  });

  // La proprietà che vale il dato autenticato aggiuntivo: chi ottiene scrittura
  // sul database non si promuove al token di un altro copiandogli la riga.
  it('se il blob viene spostato sulla riga di un altro QMate', () => {
    const sealed = seal(KEY, A_LINKEDIN_TOKEN, A_QMATE);
    expect(unseal(KEY, sealed, ANOTHER_QMATE)).toBeNull();
  });

  it('se un byte del testo cifrato è cambiato', () => {
    const sealed = seal(KEY, A_LINKEDIN_TOKEN, A_QMATE);
    sealed[sealed.length - 1] ^= 0xff;
    expect(unseal(KEY, sealed, A_QMATE)).toBeNull();
  });

  it('se il tag di autenticazione è cambiato', () => {
    const sealed = seal(KEY, A_LINKEDIN_TOKEN, A_QMATE);
    sealed[13] ^= 0xff;
    expect(unseal(KEY, sealed, A_QMATE)).toBeNull();
  });

  it.each([0, 1, 12, 28])('se il blob è lungo %i byte, cioè troncato', (length) => {
    expect(unseal(KEY, randomBytes(length), A_QMATE)).toBeNull();
  });
});
