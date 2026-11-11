/* Deterministic native process for the macOS stream-json integration test. */
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void) {
    char line[65536];
    int turn = 0;
    /* Like the real CLI, list the private temporary directory before anything else. */
    const char *scratch = getenv("CLAUDE_CODE_TMPDIR");
    DIR *dir = scratch ? opendir(scratch) : NULL;
    if (!dir) return 3;
    closedir(dir);
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
                /* The sandbox must let the agent read its workspace, not only write to it. */
                char back[16] = "";
                file = fopen("approved.txt", "r");
                if (!file || !fgets(back, sizeof(back), file) || strcmp(back, "approved"))
                    return 2;
                fclose(file);
            }
            puts("{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"first complete\"}");
        }
        fflush(stdout);
    }
    return 0;
}
