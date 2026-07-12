import type {
  CameraController,
  CameraControllerOptions,
  CameraStreamingDelegate,
  PlatformAccessory,
  PrepareStreamCallback,
  PrepareStreamRequest,
  Service,
  SnapshotRequest,
  SnapshotRequestCallback,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';
import { spawn, type ChildProcess } from 'node:child_process';

import type { VivintPlatform } from '../platform.js';
import type { DeviceData, VivintAccessoryContext } from '../types.js';
import { reservePorts } from '../utils/ports.js';
import { redactUrlCredentials } from '../utils/redact.js';
import { sanitizeDeviceName } from '../utils/sanitizeName.js';
import { VivintDict } from '../vivint/dictionary.js';
import { HapCategories, VivintDevice } from './device.js';

// To prevent double notifications, doorbell button events within this window are ignored.
const DOORBELL_IGNORE_MS = 5000;
const MOTION_RESET_MS = 5000;

interface SessionInfo {
  address: string;
  videoPort: number;
  returnVideoPort: number;
  videoSRTP: Buffer;
  videoSSRC: number;
  audioPort: number;
  returnAudioPort: number;
  audioSRTP: Buffer;
  audioSSRC: number;
}

export class Camera extends VivintDevice implements CameraStreamingDelegate {
  static override readonly className = 'Camera';

  private readonly motionService: Service;
  private readonly buttonService?: Service;
  private controller?: CameraController;

  private rtspUrl?: string;
  private lastDoorbellRing = 0;
  private readonly pendingSessions = new Map<string, SessionInfo>();
  private readonly ongoingSessions = new Map<string, ChildProcess>();

  constructor(platform: VivintPlatform, accessory: PlatformAccessory<VivintAccessoryContext>, data: DeviceData | undefined) {
    super(platform, accessory, data);

    const hap = this.platform.api.hap;
    const sanitizedName = sanitizeDeviceName(this.name, this.id);
    const isDoorbell = this.name.toLowerCase().includes('doorbell');

    this.configureRtspUrls();

    if (this.config.showCameraConfig) {
      this.logCameraConfig(isDoorbell);
    }

    if (this.config.disableCameras !== true && this.rtspUrl) {
      const streamingOptions: CameraControllerOptions['streamingOptions'] = {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [320, 180, 30],
            [320, 240, 15], // Apple Watch requires this configuration
            [320, 240, 30],
            [480, 270, 30],
            [480, 360, 30],
            [640, 360, 30],
            [640, 480, 30],
            [1280, 720, 30],
            [1280, 960, 30],
            [1920, 1080, 30],
            [1600, 1200, 30],
          ],
          codec: {
            profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH],
            levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0],
          },
        },
        // Only advertise audio when the camera supports it.
        ...(this.data.CameraInternalAudioURL ? {
          audio: {
            codecs: [{
              type: hap.AudioStreamingCodecType.AAC_ELD,
              samplerate: hap.AudioStreamingSamplerate.KHZ_16,
            }],
          },
        } : {}),
      };

      const controllerOptions: CameraControllerOptions = {
        cameraStreamCount: 2,
        delegate: this,
        streamingOptions,
      };

      this.controller = isDoorbell
        ? new hap.DoorbellController(controllerOptions)
        : new hap.CameraController(controllerOptions);
      accessory.configureController(this.controller);
    }

    this.motionService = this.ensureService(this.Service.MotionSensor, `${sanitizedName} PIV Detector`);
    this.motionService.getCharacteristic(this.Characteristic.MotionDetected)
      .onGet(() => this.getMotionDetectedState());

    if (isDoorbell) {
      // A contact sensor mirrors the doorbell button so automations can react to it.
      this.buttonService = this.ensureService(this.Service.ContactSensor, `${sanitizedName} Button`);
      this.buttonService.getCharacteristic(this.Characteristic.ContactSensorState)
        .onGet(() => this.getDoorbellButtonPress());
    }

    this.notify();
  }

  /**
   * Builds the authenticated RTSP URLs from the panel's local credentials.
   * Guarded because cameras occasionally appear in the snapshot before their
   * stream URLs are provisioned.
   */
  private configureRtspUrls(): void {
    const external = this.config.useExternalVideoStreams === true;
    const urls: string[] | undefined = external ? this.data.CameraExternalURL : this.data.CameraInternalURL;
    const panelLogin = this.vivintApi.panelLogin;

    if (!Array.isArray(urls) || urls.length === 0 || !panelLogin) {
      this.log.warn(`Camera '${this.name}' has no ${external ? 'external' : 'internal'} stream URL yet; video is unavailable for now.`);
      return;
    }

    const credentials = `rtsp://${encodeURIComponent(panelLogin.Name)}:${encodeURIComponent(panelLogin.Password)}@`;
    this.rtspUrl = urls[0].replace('rtsp://', credentials);
  }

  private logCameraConfig(isDoorbell: boolean): void {
    const informationService = this.accessory.getService(this.Service.AccessoryInformation);
    const cameraConfig = {
      name: this.data.Name,
      manufacturer: informationService?.getCharacteristic(this.Characteristic.Manufacturer).value,
      model: informationService?.getCharacteristic(this.Characteristic.Model).value,
      motion: true,
      motionTimeout: 1,
      ...(isDoorbell ? { doorbell: true } : {}),
      videoConfig: {
        source: `-rtsp_transport tcp -re -i ${redactUrlCredentials(this.rtspUrl ?? '(no stream URL)')}`,
        vcodec: 'copy',
        audio: true,
      },
    };
    this.log.info(`Camera [${this.data.Name}] configuration:`, JSON.stringify(cameraConfig, undefined, 4));
  }

  getMotionDetectedState(): boolean {
    const motionDetected = Boolean(this.data.PersonInView) || Boolean(this.data.VisitorDetected);
    // These are one-shot events; do not retain them.
    this.data.PersonInView = this.data.VisitorDetected = null;
    return motionDetected;
  }

  getDoorbellButtonPress(): boolean {
    const pressed = Boolean(this.data.DingDong);
    this.data.DingDong = null;
    return pressed;
  }

  async handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): Promise<void> {
    this.log.debug(`Handling camera snapshot for '${this.data.Name}' at ${request.width}x${request.height}`);

    if (!this.rtspUrl) {
      callback(new Error('Camera stream URL is not available'));
      return;
    }

    const snapshotArgs = [
      '-rtsp_transport', 'tcp',
      '-i', this.rtspUrl,
      '-frames:v', '1',
      '-vcodec', 'mjpeg',
      '-f', 'image2',
      '-',
    ];

    try {
      const ffmpeg = spawn(this.platform.ffmpegPath, snapshotArgs, { env: process.env });
      const snapshotBuffers: Buffer[] = [];
      let replied = false;
      const reply = (error?: Error, buffer?: Buffer) => {
        if (!replied) {
          replied = true;
          callback(error, buffer);
        }
      };

      ffmpeg.stdout.on('data', (chunk: Buffer) => snapshotBuffers.push(chunk));
      ffmpeg.stderr.on('data', (chunk: Buffer) => this.log.debug('SNAPSHOT: ' + redactUrlCredentials(String(chunk))));
      ffmpeg.on('error', error => {
        this.log.error(`Failed to start ffmpeg for a snapshot of '${this.name}':`, error.message);
        reply(error);
      });
      ffmpeg.on('exit', (code, signal) => {
        if (signal) {
          this.log.error('Snapshot process was killed with signal:', signal);
          reply(new Error('killed with signal ' + signal));
        } else if (code === 0) {
          reply(undefined, Buffer.concat(snapshotBuffers));
        } else {
          this.log.error('Snapshot process exited with code', code);
          reply(new Error('Snapshot process exited with code ' + code));
        }
      });
    } catch (error) {
      this.log.error('Error while requesting a camera snapshot:', error);
      callback(error as Error);
    }
  }

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    try {
      const hap = this.platform.api.hap;
      const sessionId = request.sessionID;

      const video = request.video;
      const returnVideoPort = (await reservePorts())[0];
      const videoSSRC = hap.CameraController.generateSynchronisationSource();

      const audio = request.audio;
      const returnAudioPort = (await reservePorts())[0];
      const audioServerPort = (await reservePorts())[0];
      const audioSSRC = hap.CameraController.generateSynchronisationSource();

      const sessionInfo: SessionInfo = {
        address: request.targetAddress,
        videoPort: video.port,
        returnVideoPort,
        videoSRTP: Buffer.concat([video.srtp_key, video.srtp_salt]),
        videoSSRC,
        audioPort: audio.port,
        returnAudioPort,
        audioSRTP: Buffer.concat([audio.srtp_key, audio.srtp_salt]),
        audioSSRC,
      };

      this.pendingSessions.set(sessionId, sessionInfo);

      callback(undefined, {
        video: {
          port: returnVideoPort,
          ssrc: videoSSRC,
          srtp_key: video.srtp_key,
          srtp_salt: video.srtp_salt,
        },
        audio: {
          port: audioServerPort,
          ssrc: audioSSRC,
          srtp_key: audio.srtp_key,
          srtp_salt: audio.srtp_salt,
        },
      });
    } catch (error) {
      this.log.error(`Failed to prepare a video stream for '${this.name}':`, error);
      callback(error as Error);
    }
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    const hap = this.platform.api.hap;
    const sessionId = request.sessionID;

    switch (request.type) {
    case hap.StreamRequestTypes.START: {
      this.log.info(`[${this.data.Name}] Starting stream for session ${sessionId}`);
      const sessionInfo = this.pendingSessions.get(sessionId);
      this.pendingSessions.delete(sessionId);
      if (!sessionInfo || !this.rtspUrl) {
        callback(new Error('No pending session or stream URL available'));
        return;
      }

      const sourceArgs = [
        '-rtsp_transport', 'tcp',
        '-i', this.rtspUrl,
      ];

      const videoArgs = [
        '-an', '-sn', '-dn',
        '-codec:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-r', `${request.video.fps}`,
        '-b:v', '1000k',
        '-bufsize', '1000k',
        '-maxrate', '1000k',
        '-payload_type', `${request.video.pt}`,
        '-ssrc', `${sessionInfo.videoSSRC}`,
        '-f', 'rtp',
        '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params', sessionInfo.videoSRTP.toString('base64'),
        `srtp://${sessionInfo.address}:${sessionInfo.videoPort}`
          + `?rtcpport=${sessionInfo.videoPort}&localrtcpport=${sessionInfo.returnVideoPort}&pkt_size=1316`,
      ];

      const audioArgs = request.audio ? [
        '-vn', '-sn', '-dn',
        '-codec:a', 'libfdk_aac',
        '-profile:a', 'aac_eld',
        '-flags', '+global_header',
        '-fflags', '+genpts',
        '-ar', '16k',
        '-b:a', '24k',
        '-ac', '1',
        '-use_wallclock_as_timestamps', '1',
        '-bufsize', '24k',
        '-payload_type', `${request.audio.pt}`,
        '-ssrc', `${sessionInfo.audioSSRC}`,
        '-f', 'rtp',
        '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
        '-srtp_out_params', sessionInfo.audioSRTP.toString('base64'),
        `srtp://${sessionInfo.address}:${sessionInfo.audioPort}`
          + `?rtcpport=${sessionInfo.audioPort}&localrtcpport=${sessionInfo.returnAudioPort}&pkt_size=188`,
      ] : [];

      const args = [...sourceArgs, ...videoArgs, ...audioArgs];
      const cmd = spawn(this.platform.ffmpegPath, args, { env: process.env });

      this.log.debug(`Started ffmpeg stream for camera '${this.data.Name}':`,
        redactUrlCredentials([this.platform.ffmpegPath, ...args].join(' ')));

      let started = false;
      cmd.stderr.on('data', (chunk: Buffer) => {
        if (!started) {
          started = true;
          this.log.debug('FFmpeg received first frame');
          callback();
        }
        this.log.debug(redactUrlCredentials(chunk.toString()));
      });

      cmd.on('error', error => {
        this.log.error('An error occurred while starting the video stream:', error.message);
        if (!started) {
          started = true;
          callback(error);
        }
      });

      cmd.on('close', code => {
        switch (code) {
        case null:
        case 0:
        case 255:
          this.log.debug('Camera stopped streaming');
          break;
        default:
          this.log.debug(`FFmpeg exited with code ${code}`);
          if (!started) {
            started = true;
            callback(new Error(`FFmpeg exited with code ${code}`));
          } else {
            this.controller?.forceStopStreamingSession(sessionId);
          }
          break;
        }
        this.ongoingSessions.delete(sessionId);
      });

      this.ongoingSessions.set(sessionId, cmd);
      break;
    }

    case hap.StreamRequestTypes.STOP: {
      const cmd = this.ongoingSessions.get(sessionId);
      try {
        cmd?.kill('SIGKILL');
      } catch (error) {
        this.log.error('Error occurred terminating the video process:', error);
      }
      this.ongoingSessions.delete(sessionId);
      callback();
      break;
    }

    case hap.StreamRequestTypes.RECONFIGURE:
      this.log.debug('(Not implemented) Received request to reconfigure the stream');
      callback();
      break;
    }
  }

  private ringDoorbell(): void {
    if (this.controller && 'ringDoorbell' in this.controller) {
      (this.controller as unknown as { ringDoorbell(): void }).ringDoorbell();
    }

    if (this.buttonService) {
      this.buttonService.updateCharacteristic(
        this.Characteristic.ContactSensorState,
        this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
      );
      setTimeout(() => {
        this.buttonService?.updateCharacteristic(
          this.Characteristic.ContactSensorState,
          this.Characteristic.ContactSensorState.CONTACT_DETECTED,
        );
      }, 500);
    }
  }

  override notify(): void {
    if (this.getMotionDetectedState()) {
      this.motionService.updateCharacteristic(this.Characteristic.MotionDetected, true);
      setTimeout(() => {
        this.motionService.updateCharacteristic(this.Characteristic.MotionDetected, false);
      }, MOTION_RESET_MS);
    }

    if (this.getDoorbellButtonPress()) {
      const now = Date.now();
      if (now - this.lastDoorbellRing >= DOORBELL_IGNORE_MS) {
        this.lastDoorbellRing = now;
        this.ringDoorbell();
      } else {
        this.log.debug('Ignoring duplicate doorbell press notification');
      }
    }
  }

  static override appliesTo(data: DeviceData): boolean {
    return data.Type === VivintDict.PanelDeviceType.Camera;
  }

  static override inferCategory(data: DeviceData, categories: HapCategories): number {
    return (data.Name ?? '').toLowerCase().includes('doorbell')
      ? categories.VIDEO_DOORBELL
      : categories.IP_CAMERA;
  }
}
