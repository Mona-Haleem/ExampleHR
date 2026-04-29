
export default class CounterService {
    globalCount = 0;
    postRequestCount = 0;

    incrementGlobal() {
        this.globalCount++;
        return this.globalCount;
    }

    incrementPost() {
        this.postRequestCount++;
        return this.postRequestCount;
    }

    reset() {
        this.globalCount = 0;
        this.postRequestCount = 0;
    }
}
