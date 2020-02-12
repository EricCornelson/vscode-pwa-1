/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import 'reflect-metadata';

/**
 * This script launches the pwa adapter in "flat session" mode for DAP, which means
 * that all DAP traffic will be routed through a single connection (either tcp socket or stdin/out)
 * and use the sessionId field on each message to route it to the correct child session
 */
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MessageEmitterConnection, ChildConnection } from './dap/flatSessionConnection';
import { TelemetryReporter } from './telemetry/telemetryReporter';
import { ILogger } from './common/logging';
import { createGlobalContainer, createTopLevelSessionContainer } from './ioc';
import {
  IDebugSessionLike,
  IConnectionStrategy,
  SessionManager,
  SessionLauncher,
} from './sessionManager';
import { IDeferred, getDeferred } from './common/promiseUtil';
import { Logger } from './common/logging/logger';

const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-js-debug-'));

class VSDebugSession implements IDebugSessionLike {
  constructor(
    public id: string,
    name: string,
    private readonly childConnection: Promise<ChildConnection>,
    private readonly mockProcessId: number,
  ) {
    this._name = name;
  }

  private _name: string;
  set name(newName: string) {
    this.childConnection
      .then(x => x.dap())
      .then(dap => {
        dap.process({ systemProcessId: this.mockProcessId, name: newName });
      });
  }
  get name() {
    return this._name;
  }
}

class VSConnectionStrategy implements IConnectionStrategy {
  deferredChildConnection: IDeferred<ChildConnection>;

  constructor(
    private readonly rootConnection: MessageEmitterConnection,
    private readonly sessionId?: string,
  ) {
    this.deferredChildConnection = getDeferred();
  }

  init(telemetryReporter: TelemetryReporter, logger: ILogger) {
    this.deferredChildConnection.resolve(
      new ChildConnection(logger, telemetryReporter, this.rootConnection, this.sessionId),
    );
  }

  getConnection() {
    return this.deferredChildConnection.promise;
  }
}

class VSSessionManager {
  private telemetry = new TelemetryReporter();
  private services = createTopLevelSessionContainer(
    createGlobalContainer({ storagePath, isVsCode: false }),
  );
  private sessionManager: SessionManager<VSDebugSession>;
  private rootConnection: MessageEmitterConnection;
  private mockProcessId = 1;

  constructor(inputStream: NodeJS.ReadableStream, outputStream: NodeJS.WritableStream) {
    this.sessionManager = new SessionManager<VSDebugSession>(
      this.services,
      this.buildVSSessionLauncher(),
    );
    this.rootConnection = new MessageEmitterConnection(this.telemetry, new Logger());

    this.createSession('', 'rootSession', {});
    this.rootConnection.init(inputStream, outputStream);
  }

  buildVSSessionLauncher(): SessionLauncher<VSDebugSession> {
    return (parentSession, target, config) => {
      const childAttachConfig = { ...config, sessionId: target.id() };

      this.createSession(target.id(), target.name(), childAttachConfig);

      // Custom message currently not part of DAP
      parentSession.connection.then(conn =>
        conn._send({
          seq: 0,
          command: 'attachedChildSession',
          type: 'request',
          arguments: {
            config: childAttachConfig,
          },
        }),
      );
    };
  }

  createSession(sessionId: string, name: string, config: any) {
    const connectionStrat = this.buildConnectionStrategy(sessionId);
    this.sessionManager.createNewSession(
      new VSDebugSession(sessionId, name, connectionStrat.getConnection(), this.mockProcessId++),
      config,
      connectionStrat,
    );
  }

  buildConnectionStrategy(sessionId?: string) {
    return new VSConnectionStrategy(this.rootConnection, sessionId);
  }
}

const debugServerPort = process.argv.length >= 3 ? +process.argv[2] : undefined;
if (debugServerPort !== undefined) {
  const server = net
    .createServer(async socket => {
      new VSSessionManager(socket, socket);
    })
    .listen(debugServerPort);
  console.log(`Listening at ${(server.address() as net.AddressInfo).port}`);
} else {
  new VSSessionManager(process.stdin, process.stdout);
}
