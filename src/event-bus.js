/**
 * Cal Gateway runtime event bus.
 *
 * Leaf module: do not import channel, HTTP, or session modules here.
 */

import { EventEmitter } from 'events';
import { appendEvent } from './event-log.js';

class CalEventBus extends EventEmitter {
  constructor() {
    super();
    this.seq = 0;
    this.setMaxListeners(50);
  }

  publish(event) {
    const fullEvent = {
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
      ...event,
    };

    appendEvent(fullEvent);
    this.emit('event', fullEvent);
    if (fullEvent.type) {
      this.emit(fullEvent.type, fullEvent);
    }
    return fullEvent;
  }

  subscribeAll(handler) {
    this.on('event', handler);
    return () => this.off('event', handler);
  }

  subscribe(type, handler) {
    this.on(type, handler);
    return () => this.off(type, handler);
  }
}

export const eventBus = new CalEventBus();

export function publishEvent(event) {
  return eventBus.publish(event);
}
