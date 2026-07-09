import type {
  ClarityVoiceCapabilityStatus,
  ClarityVoicePermissionState,
  ClarityVoiceSupportReport
} from './types';

declare global {
  interface Window {
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export type SpeechRecognitionConstructor = { new(): SpeechRecognition; available?: (options?: { langs?: string[]; processLocally?: boolean }) => Promise<Record<string, string> | string>; install?: (options?: { langs?: string[]; processLocally?: boolean }) => Promise<boolean>; };

export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { SpeechRecognition?: SpeechRecognitionConstructor }).SpeechRecognition ?? window.webkitSpeechRecognition;
}

export async function getMicrophonePermissionState(): Promise<ClarityVoicePermissionState> {
  if (typeof navigator === 'undefined') return 'unknown';

  try {
    if ('permissions' in navigator && navigator.permissions?.query) {
      const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (result.state === 'granted' || result.state === 'prompt' || result.state === 'denied') return result.state;
    }
  } catch {
    // Safari and some mobile browsers may throw for microphone permission query.
  }

  if (!navigator.mediaDevices?.getUserMedia) return 'unavailable';
  return 'unknown';
}

export async function requestMicrophoneAccess(): Promise<ClarityVoicePermissionState> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'unavailable';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return 'granted';
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) return 'denied';
    return 'unavailable';
  }
}

export async function getClarityVoiceSupportReport(): Promise<ClarityVoiceSupportReport> {
  const constructorRef = getSpeechRecognitionConstructor();
  const isSecureContext = typeof window !== 'undefined' ? window.isSecureContext : false;
  const hasMediaDevices = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
  const permissionState = await getMicrophonePermissionState();
  const notes: string[] = [];

  if (!constructorRef) notes.push('Native SpeechRecognition is not available. Keep normal typing visible.');
  if (!isSecureContext) notes.push('Speech and microphone APIs usually require HTTPS or localhost.');
  if (!hasMediaDevices) notes.push('Cannot preflight microphone access in this browser.');
  if (permissionState === 'denied') notes.push('Microphone permission is blocked.');

  const hasNativeSpeechRecognition = Boolean(constructorRef);
  const isSupported = hasNativeSpeechRecognition && isSecureContext;
  let status: ClarityVoiceCapabilityStatus = 'unsupported';
  if (isSupported && permissionState !== 'denied') status = notes.length ? 'limited' : 'supported';
  else if (hasNativeSpeechRecognition) status = 'limited';

  return {
    status,
    isSupported,
    hasNativeSpeechRecognition,
    isSecureContext,
    hasMediaDevices,
    permissionState,
    supportsContinuous: hasNativeSpeechRecognition,
    supportsInterimResults: hasNativeSpeechRecognition,
    supportsAlternatives: hasNativeSpeechRecognition,
    supportsOnDeviceAvailabilityCheck: Boolean(constructorRef && 'available' in constructorRef),
    supportsOnDeviceInstall: Boolean(constructorRef && 'install' in constructorRef),
    notes
  };
}
