import { TestBed } from '@angular/core/testing';
import { PAGE_ADDRESS } from '@axe/application/ui/page-address.token';
import {
  SAMPLE_PIECES_STORAGE_KEY,
  SamplePiecesPreferenceService,
} from '@axe/application/ui/sample-pieces-preference.service';

describe('SamplePiecesPreferenceService', () => {
  afterEach(() => {
    localStorage.removeItem(SAMPLE_PIECES_STORAGE_KEY);
  });

  function service(address = 'http://localhost:4200/'): SamplePiecesPreferenceService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: PAGE_ADDRESS, useValue: () => address }] });
    return TestBed.inject(SamplePiecesPreferenceService);
  }

  it('sets out the samples unless this browser was told not to', () => {
    expect(service().enabled()).toBe(true);
  });

  it('remembers being turned off for the next load, and on again', () => {
    service().set(false);
    expect(localStorage.getItem(SAMPLE_PIECES_STORAGE_KEY)).toBe('0');
    expect(service().enabled()).toBe(false);

    service().set(true);
    expect(localStorage.getItem(SAMPLE_PIECES_STORAGE_KEY)).toBeNull();
    expect(service().enabled()).toBe(true);
  });

  it('leaves them out for one load when the address says samples=0, without remembering it', () => {
    expect(service('http://localhost:4200/?automation=1&samples=0').enabled()).toBe(false);
    expect(localStorage.getItem(SAMPLE_PIECES_STORAGE_KEY)).toBeNull();
  });
});
