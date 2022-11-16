import { v4 } from 'uuid';
import { EventEmitter } from 'events';

import FileConverter from './fileConverter';

export class GifReverser {
  private _jobs: GifReversalJob[];
  private _jobsWaitingForWorker: GifReversalJob[];
  private _numberOfWorkers: number = navigator.hardwareConcurrency || 2;
  private _workers: Worker[];
  private _availableWorkers: Worker[];
  private _busyWorkers: Worker[];

  constructor() {
    this._jobs = [];
    this._jobsWaitingForWorker = [];

    this._workers = Array.from(Array(this._numberOfWorkers).keys()).map(() => new Worker(new URL('./processing.worker.ts', import.meta.url), {
      type: 'module'
    }));
    this._workers.forEach(w => w.onmessage = this._handleMessage.bind(this));
    this._workers.forEach(w => w.onerror = this._handleError.bind(this));

    this._availableWorkers = [...this._workers];
    this._busyWorkers = [];
  }

  private _findJobById(id: string): GifReversalJob | undefined {
    return this._jobs.find(j => j.id === id);
  }

  private _removeJobById(id: string) {
    this._jobs = this._jobs.filter(j => j.id !== id);
  }

  private _getNextWorker(): Worker | undefined {
    const worker = this._availableWorkers.pop();
    if (worker === undefined) {
      return undefined;
    }

    this._busyWorkers.push(worker);
    return worker;
  }

  private _getNextJob(): GifReversalJob | undefined {
    const job = this._jobsWaitingForWorker.shift();
    if (job === undefined) {
      return undefined;
    }

    this._jobs.push(job);
    return job;
  }

  private _makeWorkerAvailable(worker: Worker) {
    this._busyWorkers = this._busyWorkers.filter(w => w !== worker);
    this._availableWorkers.push(worker);
  }

  private _assignJobToWorker(job: GifReversalJob, worker: Worker) {
    worker.postMessage(job.getMessageForWorker());
  }

  private _distributeJobs() {
    const numberOfAvailableWorkers = this._availableWorkers.length,
      numberOfWaitingJobs = this._jobsWaitingForWorker.length,
      jobsToDistribute = Math.min(numberOfAvailableWorkers, numberOfWaitingJobs);

    for (let i = 0; i < jobsToDistribute; ++i) {
      const job = this._getNextJob();
      const worker = this._getNextWorker();
      if (job === undefined || worker === undefined) {
        continue;
      }

      this._assignJobToWorker(job, worker);
    }
  }

  private _handleMessage(event: MessageEvent) {
    const data = <MessageEventData>event.data,
      id = data.id,
      job = this._findJobById(id);
      if (job === undefined) {
        return;
      }

    switch (data.type) {
      case 'register_progress':
        job.numberOfFrames = data.numberOfFrames;
        break;
      case 'report_progress':
        job.emit('progress', <ProgressEvent>{ ...data, numberOfFrames: job.numberOfFrames });
        break;
      case 'finished':
        this._removeJobById(id);
        this._makeWorkerAvailable(<Worker>event.target);
        this._distributeJobs();
        job.emit('finished', <ReversedGif>data);
        break;
      case 'error':
        this._removeJobById(id);
        this._makeWorkerAvailable(<Worker>event.target);
        this._distributeJobs();
        job.emit('error', <ProcessingErrorEvent>data);
    }
  }

  // todo: route errors to the right job
  private _handleError(event: ErrorEvent) {
    event.preventDefault();
    console.error(event);
    console.error('An error occurred initializing the worker:', event.message, event.error);
  }

  async process(file: File): Promise<GifReversalJob> {
    const buffer = await FileConverter.readAsByteArray(file),
      { name } = file,
      id = v4(),
      job = new GifReversalJob(id, name, buffer);

    this._jobsWaitingForWorker.push(job);
    this._distributeJobs();

    return job;
  }
}

export default GifReverser;

export class GifReversalJob extends EventEmitter {
  public numberOfFrames: number = 0;

  constructor(public id: string, public name: string, public buffer: Uint8Array) {
    super();
  }

  public getMessageForWorker() {
    const {id, name, buffer} = this;
    return {id, name, buffer};
  }
}

type RegisterProgressEventData = {
  type: 'register_progress';
  id: string;
  name: string;
  numberOfFrames: number;
}

type ReportProgressEventData = {
  type: 'report_progress';
  id: string;
  name: string;
  currentFrame: number;
}

type FinishedEventData = {
  type: 'finished';
  id: string;
  name: string;
  buffer: Uint8Array;
  reversedBuffer: Uint8Array;
}

type ErrorEventData = {
  type: 'error',
  id: string;
  name: string;
  message: string;
  stack: string;
}

type MessageEventData = RegisterProgressEventData | ReportProgressEventData | FinishedEventData | ErrorEventData;

export interface ProgressEvent {
  id: string;
  name: string;
  currentFrame: number;
  numberOfFrames: number;
}

export interface ProcessingErrorEvent {
  id: string;
  name: string;
  message: string;
  stack: string;
}

export interface ReversedGif {
  id: string;
  name: string;
  buffer: Uint8Array;
  reversedBuffer: Uint8Array;
}