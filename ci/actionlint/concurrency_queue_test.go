package actionlint

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// Additional tests only: upstream fixtures and expectations remain untouched.
func TestConcurrencyQueueCompatibility(t *testing.T) {
	var cases []struct {
		Name  string
		Block string
		Valid bool
		Queue ConcurrencyQueue
		Error string
	}
	data, err := os.ReadFile("queue-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, scope := range []string{"workflow", "job"} {
		for _, tc := range cases {
			t.Run(scope+"/"+tc.Name, func(t *testing.T) {
				block := "concurrency:\n  " + strings.ReplaceAll(tc.Block, "\n", "\n  ") + "\n"
				job := "jobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n"
				source := "on: push\n" + block + job
				if scope == "job" {
					source = "on: push\n" + job + "    " + strings.TrimSuffix(strings.ReplaceAll(block, "\n", "\n    "), "    ")
				}
				workflow, errors := Parse([]byte(source))
				if tc.Valid {
					if len(errors) != 0 {
						t.Fatalf("unexpected parser errors: %v", errors)
					}
					concurrency := workflow.Concurrency
					if scope == "job" {
						concurrency = workflow.Jobs["check"].Concurrency
					}
					if concurrency == nil || concurrency.Queue != tc.Queue {
						t.Fatalf("typed queue not preserved: %#v", concurrency)
					}
				} else {
					found := false
					for _, err := range errors {
						found = found || strings.Contains(err.Message, tc.Error)
					}
					if !found {
						t.Fatalf("expected %q, got %v", tc.Error, errors)
					}
				}
			})
		}
	}
}
