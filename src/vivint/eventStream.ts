import type { Logging } from 'homebridge';
import PubNub from 'pubnub';

const PUBNUB_SUBSCRIBE_KEY = 'sub-c-6fb03d68-6a78-11e2-ae8f-12313f022c90';

/**
 * Realtime device event stream. Vivint pushes device updates over PubNub;
 * the SDK handles reconnection with its own backoff, we just surface status
 * changes in the log without spamming.
 */
export class VivintEventStream {
  private pubnub?: PubNub;
  private connectionLost = false;

  constructor(private readonly log: Logging) {}

  start(messageBroadcastChannel: string, onMessage: (message: object) => void): void {
    this.stop();

    const pubnub = new PubNub({
      subscribeKey: PUBNUB_SUBSCRIBE_KEY,
      userId: messageBroadcastChannel,
    });

    pubnub.addListener({
      status: statusEvent => {
        switch (statusEvent.category) {
        case 'PNConnectedCategory':
          this.connectionLost = false;
          this.log.debug('Connected to the Vivint realtime event stream.');
          break;
        case 'PNReconnectedCategory':
          this.connectionLost = false;
          this.log.info('Reconnected to the Vivint realtime event stream.');
          break;
        case 'PNNetworkDownCategory':
        case 'PNNetworkIssuesCategory':
        case 'PNTimeoutCategory':
        case 'PNDisconnectedUnexpectedlyCategory':
          // Log the first drop at warn, subsequent ones at debug to avoid
          // flooding the log during a longer outage.
          if (!this.connectionLost) {
            this.connectionLost = true;
            this.log.warn('Lost connection to the Vivint realtime event stream, reconnecting automatically. '
              + 'Device updates rely on periodic polling until the connection is restored.');
          } else {
            this.log.debug('Vivint realtime event stream still down (%s).', statusEvent.category);
          }
          break;
        default:
          this.log.debug('Vivint realtime event stream status:', statusEvent.category);
        }
      },
      message: event => {
        try {
          onMessage(event.message as object);
        } catch (error) {
          // A malformed message must never take down the plugin.
          this.log.error('Failed to process a Vivint realtime message:', error);
        }
      },
    });

    pubnub.subscribe({ channels: [`PlatformChannel#${messageBroadcastChannel}`] });
    this.pubnub = pubnub;
  }

  stop(): void {
    if (this.pubnub) {
      try {
        this.pubnub.unsubscribeAll();
        this.pubnub.stop();
      } catch (error) {
        this.log.debug('Error while shutting down the event stream:', error);
      }
      this.pubnub = undefined;
    }
  }
}
