/*
 * Copyright (C) 2019 HERE Europe B.V.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 * License-Filename: LICENSE
 */

import { DownloadManager } from "./DownloadManager";

/** @internal
 * DeferredPromise takes an executor function for executing it later, when [[exec]] is called.
 * This class allows wrapping other promises or long running functions for later execution.
 */
class DeferredPromise<T> {
    /**
     * Internal promise to store the deferred executor function.
     */
    readonly promise: Promise<T>;
    private resolveFunc?: (result?: T) => void;
    private rejectFunc?: (reason?: any) => void;

    constructor(private readonly executor: () => Promise<T>) {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolveFunc = resolve;
            this.rejectFunc = reject;
        });
    }

    /**
     * When `exec` is called the deferred executor function is executed.
     */
    exec() {
        this.executor()
            .then(this.resolveFunc)
            .catch(this.rejectFunc);
    }
}

/**
 * `DataStoreDownloadManager` for downloading URLs.
 *
 * Features:
 *
 * * Limits the amount of parallel downloads, useful when requesting a large amount of URLs that
 *   would otherwise stall the browser.
 * * Retries the downloads with an increasing timeout on HTTP 503 replies.
 */
export class DataStoreDownloadManager implements DownloadManager {
    /**
     * The timeout in milliseconds to wait between retries. This timeout is multiplied with the
     * number of retries. First retry waits for 0 ms, second retry for 500 ms, third for 1000 ms and
     * so on.
     */
    static readonly retryTimeout = 500;

    /**
     * The amount of maximum parallel downloads to allow.
     */
    static readonly maxParallelDownloads = 16;

    private activeDownloadCount = 0;

    private downloadQueue = new Array<DeferredPromise<Response>>();

    /**
     * Retries the downloads with an increasing timeout on HTTP 503 replies.
     *
     * @param fetchFunction typeof fetch
     * @param retryCount int, the counter of tries re-fetch response after 503 response
     * @param maxRetries int, the maximum amount of trying to re-fetch after 503 response
     * @param url string, url to endpoint
     * @param init RequestInit, extra request params
     */
    private static async fetchRepeatedly(
        fetchFunction: typeof fetch,
        retryCount: number,
        maxRetries: number,
        url: string,
        init?: RequestInit
    ): Promise<Response> {
        try {
            const response = await fetchFunction(url, init);
            // tslint:disable-next-line: no-magic-numbers
            if (response.status !== 503 || retryCount >= maxRetries) {
                return response;
            }
        } catch (err) {
            if (
                err.hasOwnProperty("isCancelled") ||
                (err.hasOwnProperty("name") && err.name === "AbortError") ||
                retryCount > maxRetries
            ) {
                throw err;
            }
        }
        return DataStoreDownloadManager.waitFor(
            DataStoreDownloadManager.retryTimeout * retryCount
        ).then(() =>
            DataStoreDownloadManager.fetchRepeatedly(
                fetchFunction,
                retryCount + 1,
                maxRetries,
                url,
                init
            )
        );
    }

    private static async waitFor(milliseconds: number): Promise<void> {
        return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
    }

    /**
     * Constructs a new [[DataStoreDownloadManager]].
     *
     * @param fetchFunction The default fetch function to use.
     * @param maxRetries The maximum amount to try to re-fetch a resource.
     */
    constructor(
        readonly fetchFunction = fetch,
        readonly maxRetries: number = 5
    ) {}

    /**
     * Downloads a URL and returns the response.
     *
     * Does not merge multiple requests to the same URL.
     *
     * @param url The URL to download.
     * @param init Optional extra parameters for the download.
     */
    async download(url: string, init?: RequestInit): Promise<Response> {
        if (
            this.activeDownloadCount >=
            DataStoreDownloadManager.maxParallelDownloads
        ) {
            const deferred = new DeferredPromise<Response>(() =>
                this.doDownload(url, init)
            );
            this.downloadQueue.push(deferred);
            return deferred.promise;
        }
        return this.doDownload(url, init);
    }

    private async doDownload(
        url: string,
        init?: RequestInit
    ): Promise<Response> {
        ++this.activeDownloadCount;
        return DataStoreDownloadManager.fetchRepeatedly(
            this.fetchFunction,
            0,
            this.maxRetries,
            url,
            init
        )
            .then(response => {
                this.onDownloadDone();
                return response;
            })
            .catch(err => {
                this.onDownloadDone();
                throw err;
            });
    }
    private onDownloadDone() {
        --this.activeDownloadCount;
        this.execDeferredDownload();
    }
    private execDeferredDownload() {
        const future = this.downloadQueue.pop();
        if (future === undefined) {
            return;
        }
        future.exec();
    }
}
