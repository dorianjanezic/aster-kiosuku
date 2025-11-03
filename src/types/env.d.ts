declare namespace NodeJS {
    interface ProcessEnv {
        ASTER_BASE_URL?: string;
        ASTER_BASE_PATH?: string;
        ASTER_API_KEY?: string;
        ASTER_API_SECRET?: string;
        LOOP_INTERVAL_MS?: string;
        CMC_API_KEY?: string;
        CMC_SAMPLE_SIZE?: string;
    }
}

