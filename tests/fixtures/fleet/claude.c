/* Deterministic native process for the macOS stream-json integration test. */
#include <stdio.h>
#include <string.h>

int main(void) {
    char line[65536];
    int turn = 0;
    while (fgets(line, sizeof(line), stdin)) {
        if (strstr(line, "\"type\":\"user\"")) {
            if (strstr(line, "fleet-hold")) continue;
            if (++turn == 1) {
                puts("{\"type\":\"control_request\",\"request_id\":\"cli-1\","
                     "\"request\":{\"subtype\":\"can_use_tool\",\"tool_name\":\"Write\","
                     "\"input\":{\"file_path\":\"approved.txt\",\"content\":\"approved\"}}}");
            } else {
                printf("{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"followup %d\"}\n", turn);
            }
        } else if (strstr(line, "\"type\":\"control_response\"")) {
            if (strstr(line, "\"behavior\":\"allow\"")) {
                FILE *file = fopen("approved.txt", "w");
                if (!file) return 1;
                fputs("approved", file);
                if (fclose(file)) return 1;
            }
            puts("{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"first complete\"}");
        }
        fflush(stdout);
    }
    return 0;
}
