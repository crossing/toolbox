package cli

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/crossing/toolbox/tools/freeagent/internal/freeagent"

	"github.com/spf13/cobra"
)



var (
	accessToken string
	apiClient   *freeagent.Client
	humanOutput bool
)

// rootCmd represents the base command when called without any subcommands
var rootCmd = &cobra.Command{
	Use:   "freeagent",
	Short: "A CLI for FreeAgent bookkeeping and accounting software",
	Long: `A CLI designed for AI agents to operate FreeAgent via its API.
Focuses on bank transaction explanations, bills, and attachments.`,
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		if accessToken == "" {
			accessToken = os.Getenv("FREEAGENT_ACCESS_TOKEN")
		}
		if accessToken == "" {
			return fmt.Errorf("FREEAGENT_ACCESS_TOKEN environment variable or --token flag is required")
		}
		apiClient = freeagent.NewClient(accessToken)
		return nil
	},
}

func formatOutput(v interface{}) error {
	var encoder *json.Encoder
	encoder = json.NewEncoder(os.Stdout)
	if humanOutput {
		encoder.SetIndent("", "  ")
	}
	return encoder.Encode(v)
}

func Execute() {
	err := rootCmd.Execute()
	if err != nil {
		os.Exit(1)
	}
}

func init() {
	rootCmd.PersistentFlags().StringVar(&accessToken, "token", "", "FreeAgent Access Token")
	rootCmd.PersistentFlags().BoolVar(&humanOutput, "human", false, "Output human-readable format")
}


