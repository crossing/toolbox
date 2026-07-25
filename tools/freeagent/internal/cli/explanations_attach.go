package cli

import (
	"github.com/crossing/toolbox/tools/freeagent/internal/freeagent"

	"github.com/spf13/cobra"
)

var (
	expURL  string
	expFile string
)

// explanationsAttachCmd represents the attach command
var explanationsAttachCmd = &cobra.Command{
	Use:   "attach",
	Short: "Attach a file to an explanation",
	Long:  "Attach a local file (receipt or invoice) to an existing bank transaction explanation.",
	RunE: func(cmd *cobra.Command, args []string) error {
		attachment, err := freeagent.CreateAttachmentFromFile(expFile)
		if err != nil {
			return err
		}

		explanation := freeagent.BankTransactionExplanation{
			Attachment: attachment,
		}

		updatedExp, err := apiClient.UpdateBankTransactionExplanation(expURL, explanation)
		if err != nil {
			return err
		}

		return formatOutput(updatedExp)
	},
}

func init() {
	explanationsCmd.AddCommand(explanationsAttachCmd)

	explanationsAttachCmd.Flags().StringVar(&expURL, "url", "", "Explanation URI")
	explanationsAttachCmd.Flags().StringVar(&expFile, "file", "", "Path to the file to attach")

	_ = explanationsAttachCmd.MarkFlagRequired("url")
	_ = explanationsAttachCmd.MarkFlagRequired("file")
}
