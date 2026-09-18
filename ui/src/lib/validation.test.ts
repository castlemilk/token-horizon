import { describe, expect, it } from 'vitest';
import {
	isLoopbackHost,
	normalizeHandle,
	validateEndpoint,
	validatePort,
	validateUsername
} from './validation';

describe('normalizeHandle', () => {
	it('trims, lowercases and strips @', () => {
		expect(normalizeHandle('  @Alice ')).toBe('alice');
		expect(normalizeHandle('BOB-1')).toBe('bob-1');
	});
});

describe('validateUsername (mirrors server ValidateHandle)', () => {
	it('accepts the contract', () => {
		expect(validateUsername('alice')).toBeNull();
		expect(validateUsername('bo-b_1')).toBeNull();
		expect(validateUsername('  @Al ')).toBeNull();
		expect(validateUsername('a'.repeat(32))).toBeNull();
	});
	it('empty is neutral', () => {
		expect(validateUsername('')).toBeNull();
		expect(validateUsername('   ')).toBeNull();
	});
	it('rejects bad lengths', () => {
		expect(validateUsername('a')).not.toBeNull();
		expect(validateUsername('a'.repeat(33))).not.toBeNull();
	});
	it('rejects bad characters', () => {
		expect(validateUsername('al ice')).not.toBeNull();
		expect(validateUsername('alice!')).not.toBeNull();
		expect(validateUsername('UPPER'.toLowerCase().toUpperCase())).toBeNull(); // case folds
		expect(validateUsername('double--dash')).toBeNull();
	});
});

describe('isLoopbackHost', () => {
	it('matches loopbacks only', () => {
		for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.9.0.2', '::1', '[::1]']) {
			expect(isLoopbackHost(h)).toBe(true);
		}
		for (const h of ['ollama', 'example.com', '192.168.1.5', '10.0.0.1', '128.0.0.1']) {
			expect(isLoopbackHost(h)).toBe(false);
		}
	});
});

describe('validateEndpoint', () => {
	it('empty is neutral', () => {
		expect(validateEndpoint('')).toBeNull();
		expect(validateEndpoint('   ')).toBeNull();
	});
	it('accepts local endpoints with ports', () => {
		expect(validateEndpoint('http://127.0.0.1:11434')).toBeNull();
		expect(validateEndpoint('http://localhost:8080/v1')).toBeNull();
		expect(validateEndpoint('http://[::1]:11435')).toBeNull();
	});
	it('rejects loopbacks without ports', () => {
		expect(validateEndpoint('http://127.0.0.1')).not.toBeNull();
		expect(validateEndpoint('http://localhost/v1')).not.toBeNull();
	});
	it('accepts proper externals', () => {
		expect(validateEndpoint('https://api.example.com')).toBeNull();
		expect(validateEndpoint('https://api.example.com/v1')).toBeNull();
		expect(validateEndpoint('http://192.168.1.5:8000')).toBeNull();
		expect(validateEndpoint('http://ollama:11434')).toBeNull();
	});
	it('rejects bare single-label names', () => {
		expect(validateEndpoint('http://ollama')).not.toBeNull();
	});
	it('rejects non-http schemes and garbage', () => {
		expect(validateEndpoint('ftp://x.com')).not.toBeNull();
		expect(validateEndpoint('not a url')).not.toBeNull();
		expect(validateEndpoint('http://x:99999')).not.toBeNull();
	});
});

describe('validatePort', () => {
	it('empty is neutral', () => {
		expect(validatePort('')).toBeNull();
	});
	it('accepts 1–65535 digits', () => {
		expect(validatePort('11434')).toBeNull();
		expect(validatePort('1')).toBeNull();
		expect(validatePort('65535')).toBeNull();
	});
	it('rejects out-of-range and non-digits', () => {
		expect(validatePort('0')).not.toBeNull();
		expect(validatePort('65536')).not.toBeNull();
		expect(validatePort('12a4')).not.toBeNull();
		expect(validatePort(' 12 ')).toBeNull();
	});
});
